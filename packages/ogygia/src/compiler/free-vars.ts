import { walk } from 'estree-walker';
import type { SvelteNode } from './region/ir.js';

/**
 * Free-variable analysis over a Svelte 5 template subtree.
 *
 * Given an array of top-level template nodes (a hoisted island subtree), returns
 * the set of identifier names that are referenced inside the subtree but bound
 * OUTSIDE it (host `<script>` vars, outer `{#each}` locals, component imports,
 * globals...), PLUS the set of those free names that are the TARGET of a mutation
 * (assignment / update / compound-assign / destructuring-assignment / `bind:`).
 * Identifiers bound *within* the subtree (snippet params, each locals, `{@const}`,
 * `{#await}` value/error, `let:` directives, and JS-level function params) are
 * excluded from both sets.
 *
 * The mutation set powers a build-time guard: captured host state crosses the
 * boundary as a serialized SNAPSHOT, so writing to it inside an island updates
 * nothing. The transform turns a mutated capture into a precise error.
 */

const FUNCTION_TYPES = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression'
]);

// Minimal estree shape for the function-scope handling (no @types/estree dependency).
interface EsFunction {
	id?: { name: string } | null;
	params: unknown[];
}

/** Accumulators threaded through the whole analysis. */
interface Sink {
	/** free references (reads) */
	refs: Set<string>;
	/** free names written to (assignment / update / bind target root) */
	mutated: Set<string>;
	/**
	 * Free `$`-prefixed references (store auto-subscriptions like `$country`, plus the
	 * `$$props` family), with every occurrence's source offsets. The sugar is host-scoped:
	 * emitted verbatim into a synth entry it names an out-of-scope `$`-identifier, which
	 * runes mode rejects — the transform captures the subscription VALUE and rewrites these
	 * exact spans to the capture's prop name instead.
	 */
	stores: Map<string, Array<{ start: number; end: number }>>;
}

/** Collect bound names from an estree binding pattern. */
function collect_pattern_names(node: SvelteNode, out: Set<string>) {
	if (!node) return;
	switch (node.type) {
		case 'Identifier':
			out.add(node.name);
			break;
		case 'ObjectPattern':
			for (const prop of node.properties) {
				if (prop.type === 'RestElement') collect_pattern_names(prop.argument, out);
				else collect_pattern_names(prop.value, out);
			}
			break;
		case 'ArrayPattern':
			for (const el of node.elements) collect_pattern_names(el, out);
			break;
		case 'AssignmentPattern':
			collect_pattern_names(node.left, out);
			break;
		case 'RestElement':
			collect_pattern_names(node.argument, out);
			break;
	}
}

/** The leftmost identifier name of a member chain (`a.b.c` -> `a`), or null. */
function member_root(node: SvelteNode): string | null {
	let cur = node;
	while (cur && cur.type === 'MemberExpression') cur = cur.object;
	return cur && cur.type === 'Identifier' ? cur.name : null;
}

/**
 * Collect the ROOT identifier names written by an assignment/update target — an
 * Identifier (`x = …`), a MemberExpression (`x.a = …` -> `x`), or a destructuring
 * pattern (`[x] = …`, `({ x } = …)`, defaults, rests, nested member targets).
 */
function collect_write_roots(target: SvelteNode, roots: Set<string>) {
	if (!target) return;
	switch (target.type) {
		case 'Identifier':
			roots.add(target.name);
			break;
		case 'MemberExpression': {
			const r = member_root(target);
			if (r) roots.add(r);
			break;
		}
		case 'ObjectPattern':
			for (const prop of target.properties) {
				if (prop.type === 'RestElement') collect_write_roots(prop.argument, roots);
				else collect_write_roots(prop.value, roots);
			}
			break;
		case 'ArrayPattern':
			for (const el of target.elements) if (el) collect_write_roots(el, roots);
			break;
		case 'AssignmentPattern':
			collect_write_roots(target.left, roots);
			break;
		case 'RestElement':
			collect_write_roots(target.argument, roots);
			break;
	}
}

/** Is this Identifier node a *reference* (a read) rather than a binding/property name? */
function is_reference(
	node: SvelteNode,
	parent: SvelteNode,
	key: string | number | symbol | null | undefined
) {
	if (!parent) return true;
	switch (parent.type) {
		// obj.prop -> `prop` is not a reference (unless computed)
		case 'MemberExpression':
			if (key === 'property' && !parent.computed) return false;
			return true;
		// { prop: value } -> `prop` key is not a reference (unless computed/shorthand handled below)
		case 'Property':
			if (key === 'key' && !parent.computed) {
				// shorthand { x } -> key === value === same node, still a reference read
				return parent.shorthand;
			}
			return true;
		// binding ids are not references
		case 'VariableDeclarator':
			return key !== 'id';
		case 'FunctionDeclaration':
		case 'FunctionExpression':
		case 'ArrowFunctionExpression':
			return key !== 'id' && key !== 'params';
		case 'ImportSpecifier':
		case 'ImportDefaultSpecifier':
		case 'ImportNamespaceSpecifier':
			return false;
		case 'LabeledStatement':
		case 'BreakStatement':
		case 'ContinueStatement':
			return key !== 'label';
		case 'CatchClause':
			return key !== 'param';
		default:
			return true;
	}
}

/**
 * Walk one estree expression, adding any free references (not bound by inner
 * JS function scopes and not in `svelte_bound`) into `sink.refs`, and any free
 * assignment/update targets into `sink.mutated`.
 */
function add_expression_refs(expr: SvelteNode, svelte_bound: Set<string>, sink: Sink) {
	if (!expr) return;
	const scopes: Set<string>[] = [new Set()];
	const has = (name: string) => {
		if (svelte_bound.has(name)) return true;
		for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return true;
		return false;
	};
	const record_writes = (target: SvelteNode) => {
		const roots = new Set<string>();
		collect_write_roots(target, roots);
		for (const r of roots) if (!has(r)) sink.mutated.add(r);
	};
	walk(expr, {
		enter(node, parent, key) {
			if (FUNCTION_TYPES.has(node.type)) {
				const s = new Set<string>();
				const fn = node as EsFunction;
				if (fn.id && node.type !== 'ArrowFunctionExpression') s.add(fn.id.name);
				for (const p of fn.params) collect_pattern_names(p, s);
				scopes.push(s);
			} else if (node.type === 'BlockStatement' && !FUNCTION_TYPES.has(parent?.type ?? '')) {
				scopes.push(new Set());
			} else if (node.type === 'VariableDeclarator') {
				collect_pattern_names(node.id, scopes[scopes.length - 1]);
			} else if (node.type === 'CatchClause' && node.param) {
				collect_pattern_names(node.param, scopes[scopes.length - 1]);
			} else if (node.type === 'AssignmentExpression') {
				record_writes(node.left);
			} else if (node.type === 'UpdateExpression') {
				record_writes(node.argument);
			} else if (node.type === 'Identifier' && is_reference(node, parent, key)) {
				if (!has(node.name)) {
					sink.refs.add(node.name);
					if (node.name.startsWith('$') && node.start != null && node.end != null) {
						let sites = sink.stores.get(node.name);
						if (!sites) sink.stores.set(node.name, (sites = []));
						sites.push({ start: node.start, end: node.end });
					}
				}
			}
		},
		leave(node, parent) {
			if (FUNCTION_TYPES.has(node.type)) scopes.pop();
			else if (node.type === 'BlockStatement' && !FUNCTION_TYPES.has(parent?.type ?? ''))
				scopes.pop();
		}
	});
}

/** Names introduced by `let:` directives on an element/component. */
function let_directive_names(node: SvelteNode): Set<string> {
	const names = new Set<string>();
	for (const attr of node.attributes ?? []) {
		if (attr.type === 'LetDirective') {
			if (attr.expression) collect_pattern_names(attr.expression, names);
			else names.add(attr.name);
		}
	}
	return names;
}

/** Walk attribute expressions of an element/component (not `let:`, which binds). */
function add_attribute_refs(node: SvelteNode, bound: Set<string>, sink: Sink) {
	for (const attr of node.attributes ?? []) {
		switch (attr.type) {
			case 'Attribute':
				if (attr.value === true) break; // boolean attribute
				if (Array.isArray(attr.value)) {
					for (const part of attr.value) {
						if (part.type === 'ExpressionTag') add_expression_refs(part.expression, bound, sink);
					}
				} else if (attr.value?.type === 'ExpressionTag') {
					// single-expression attribute: `a={x}` or shorthand `{x}`
					add_expression_refs(attr.value.expression, bound, sink);
				}
				break;
			case 'SpreadAttribute':
				add_expression_refs(attr.expression, bound, sink);
				break;
			case 'LetDirective':
				break;
			case 'BindDirective':
				// `bind:value={target}` READS and WRITES `target`. Record the write-root so a
				// `bind:` into a captured host snapshot is caught (it would update nothing).
				if (attr.expression) {
					add_expression_refs(attr.expression, bound, sink);
					const root =
						attr.expression.type === 'Identifier'
							? attr.expression.name
							: member_root(attr.expression);
					if (root && !bound.has(root)) sink.mutated.add(root);
				}
				break;
			default:
				// On/Class/Style/Transition/Animate/Use/In/Out directives
				if (attr.expression) add_expression_refs(attr.expression, bound, sink);
		}
	}
}

/** Collect snippet names + const-declared names defined at this fragment level. */
function sibling_bindings(nodes: SvelteNode[]) {
	const names = new Set<string>();
	for (const n of nodes) {
		if (n.type === 'SnippetBlock' && n.expression) names.add(n.expression.name);
		else if (n.type === 'ConstTag') {
			for (const d of n.declaration.declarations) collect_pattern_names(d.id, names);
		}
	}
	return names;
}

function fragment_nodes(fragment: SvelteNode): SvelteNode[] {
	return fragment?.nodes ?? [];
}

/**
 * @param nodes top-level nodes of the subtree
 * @param outer_bound names bound outside (usually empty at entry)
 * @param sink accumulates free references + mutations
 */
function walk_template(nodes: SvelteNode[], outer_bound: Set<string>, sink: Sink) {
	const bound = new Set(outer_bound);
	for (const name of sibling_bindings(nodes)) bound.add(name);

	for (const node of nodes) {
		switch (node.type) {
			case 'Text':
			case 'Comment':
				break;
			case 'ExpressionTag':
			case 'HtmlTag':
			case 'RenderTag':
				add_expression_refs(node.expression, bound, sink);
				break;
			case 'ConstTag':
				for (const d of node.declaration.declarations) add_expression_refs(d.init, bound, sink);
				break;
			case 'IfBlock':
				add_expression_refs(node.test, bound, sink);
				walk_template(fragment_nodes(node.consequent), bound, sink);
				if (node.alternate) walk_template(fragment_nodes(node.alternate), bound, sink);
				break;
			case 'EachBlock': {
				add_expression_refs(node.expression, bound, sink);
				const each_bound = new Set(bound);
				collect_pattern_names(node.context, each_bound);
				if (node.index) each_bound.add(node.index);
				if (node.key) add_expression_refs(node.key, each_bound, sink);
				walk_template(fragment_nodes(node.body), each_bound, sink);
				if (node.fallback) walk_template(fragment_nodes(node.fallback), bound, sink);
				break;
			}
			case 'AwaitBlock': {
				add_expression_refs(node.expression, bound, sink);
				if (node.pending) walk_template(fragment_nodes(node.pending), bound, sink);
				if (node.then) {
					const then_bound = new Set(bound);
					if (node.value) collect_pattern_names(node.value, then_bound);
					walk_template(fragment_nodes(node.then), then_bound, sink);
				}
				if (node.catch) {
					const catch_bound = new Set(bound);
					if (node.error) collect_pattern_names(node.error, catch_bound);
					walk_template(fragment_nodes(node.catch), catch_bound, sink);
				}
				break;
			}
			case 'KeyBlock':
				add_expression_refs(node.expression, bound, sink);
				walk_template(fragment_nodes(node.fragment), bound, sink);
				break;
			case 'SnippetBlock': {
				const snip_bound = new Set(bound);
				for (const p of node.parameters ?? []) collect_pattern_names(p, snip_bound);
				walk_template(fragment_nodes(node.body), snip_bound, sink);
				break;
			}
			case 'Component':
			case 'SvelteComponent': {
				// the component name (`Foo` or `Foo.Bar`) references an import/host binding
				const root = String(node.name || '').split('.')[0];
				if (root && !bound.has(root)) sink.refs.add(root);
				add_attribute_refs(node, bound, sink);
				const el_bound1 = new Set(bound);
				for (const name of let_directive_names(node)) el_bound1.add(name);
				if (node.fragment) walk_template(fragment_nodes(node.fragment), el_bound1, sink);
				break;
			}
			case 'RegularElement':
			case 'SvelteElement':
			case 'SvelteSelf':
			case 'SvelteFragment':
			case 'SvelteBoundary':
			case 'SlotElement':
			case 'TitleElement': {
				if (node.tag) add_expression_refs(node.tag, bound, sink); // <svelte:element this={tag}>
				add_attribute_refs(node, bound, sink);
				const el_bound = new Set(bound);
				for (const name of let_directive_names(node)) el_bound.add(name);
				if (node.fragment) walk_template(fragment_nodes(node.fragment), el_bound, sink);
				break;
			}
			default:
				if (node.fragment) walk_template(fragment_nodes(node.fragment), bound, sink);
		}
	}
}

/** Collect all snippet names defined anywhere in a subtree (for cross-boundary error detection). */
export function collectSnippetNames(nodes: SvelteNode[]) {
	const out = new Set();
	const visit = (list: SvelteNode[]) => {
		for (const n of list ?? []) {
			if (n.type === 'SnippetBlock' && n.expression) out.add(n.expression.name);
			for (const k of [
				'consequent',
				'alternate',
				'body',
				'fallback',
				'pending',
				'then',
				'catch',
				'fragment'
			]) {
				if (n[k]?.nodes) visit(n[k].nodes);
			}
		}
	};
	visit(nodes);
	return out;
}

/**
 * @param nodes hoisted subtree top-level nodes
 * @returns free identifier names + free mutation targets + `$store` read sites
 */
export function collectCaptureInfo(nodes: SvelteNode[]) {
	const sink: Sink = { refs: new Set(), mutated: new Set(), stores: new Map() };
	walk_template(nodes, new Set(), sink);
	return { free: sink.refs, mutated: sink.mutated, stores: sink.stores };
}

/**
 * @param nodes hoisted subtree top-level nodes
 * @returns free identifier names
 */
export function collectFreeIdentifiers(nodes: SvelteNode[]) {
	return collectCaptureInfo(nodes).free;
}
