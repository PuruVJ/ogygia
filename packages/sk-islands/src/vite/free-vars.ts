import { walk } from 'estree-walker';

/**
 * Free-variable analysis over a Svelte 5 template subtree.
 *
 * Given an array of top-level template nodes (a hoisted island subtree), returns
 * the set of identifier names that are referenced inside the subtree but bound
 * OUTSIDE it (host `<script>` vars, outer `{#each}` locals, component imports,
 * globals...). Identifiers bound *within* the subtree (snippet params, each
 * locals, `{@const}`, `{#await}` value/error, `let:` directives, and JS-level
 * function params) are excluded.
 */

const FUNCTION_TYPES = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression'
]);

/** Collect bound names from an estree binding pattern. */
function collect_pattern_names(node, out) {
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

/** Is this Identifier node a *reference* (a read) rather than a binding/property name? */
function is_reference(node, parent, key) {
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
 * JS function scopes and not in `svelte_bound`) into `out`.
 */
function add_expression_refs(expr, svelte_bound, out) {
	if (!expr) return;
	const scopes = [new Set()];
	const has = (name) => {
		if (svelte_bound.has(name)) return true;
		for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return true;
		return false;
	};
	walk(expr, {
		enter(node, parent, key) {
			if (FUNCTION_TYPES.has(node.type)) {
				const s = new Set();
				if ((node as any).id && node.type !== "ArrowFunctionExpression") s.add((node as any).id.name);
				for (const p of (node as any).params) collect_pattern_names(p, s);
				scopes.push(s);
			} else if (node.type === 'BlockStatement' && !FUNCTION_TYPES.has(parent?.type)) {
				scopes.push(new Set());
			} else if (node.type === 'VariableDeclarator') {
				collect_pattern_names(node.id, scopes[scopes.length - 1]);
			} else if (node.type === 'CatchClause' && node.param) {
				collect_pattern_names(node.param, scopes[scopes.length - 1]);
			} else if (node.type === 'Identifier' && is_reference(node, parent, key)) {
				if (!has(node.name)) out.add(node.name);
			}
		},
		leave(node, parent) {
			if (FUNCTION_TYPES.has(node.type)) scopes.pop();
			else if (node.type === 'BlockStatement' && !FUNCTION_TYPES.has(parent?.type)) scopes.pop();
		}
	});
}

/** Names introduced by `let:` directives on an element/component. */
function let_directive_names(node) {
	const names = new Set();
	for (const attr of node.attributes ?? []) {
		if (attr.type === 'LetDirective') {
			if (attr.expression) collect_pattern_names(attr.expression, names);
			else names.add(attr.name);
		}
	}
	return names;
}

/** Walk attribute expressions of an element/component (not `let:`, which binds). */
function add_attribute_refs(node, bound, out) {
	for (const attr of node.attributes ?? []) {
		switch (attr.type) {
			case 'Attribute':
				if (attr.value === true) break; // boolean attribute
				if (Array.isArray(attr.value)) {
					for (const part of attr.value) {
						if (part.type === 'ExpressionTag') add_expression_refs(part.expression, bound, out);
					}
				} else if (attr.value?.type === 'ExpressionTag') {
					// single-expression attribute: `a={x}` or shorthand `{x}`
					add_expression_refs(attr.value.expression, bound, out);
				}
				break;
			case 'SpreadAttribute':
				add_expression_refs(attr.expression, bound, out);
				break;
			case 'LetDirective':
				break;
			default:
				// Bind/On/Class/Style/Transition/Animate/Use/In/Out directives
				if (attr.expression) add_expression_refs(attr.expression, bound, out);
		}
	}
}

/** Collect snippet names + const-declared names defined at this fragment level. */
function sibling_bindings(nodes) {
	const names = new Set();
	for (const n of nodes) {
		if (n.type === 'SnippetBlock' && n.expression) names.add(n.expression.name);
		else if (n.type === 'ConstTag') {
			for (const d of n.declaration.declarations) collect_pattern_names(d.id, names);
		}
	}
	return names;
}

function fragment_nodes(fragment) {
	return fragment?.nodes ?? [];
}

/**
 * @param {any[]} nodes top-level nodes of the subtree
 * @param {Set<string>} outer_bound names bound outside (usually empty at entry)
 * @param {Set<string>} out accumulates free references
 * @param {(name:string)=>void} [onSnippet] called with snippet names defined here (for error reporting)
 */
function walk_template(nodes, outer_bound, out) {
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
				add_expression_refs(node.expression, bound, out);
				break;
			case 'ConstTag':
				for (const d of node.declaration.declarations) add_expression_refs(d.init, bound, out);
				break;
			case 'IfBlock':
				add_expression_refs(node.test, bound, out);
				walk_template(fragment_nodes(node.consequent), bound, out);
				if (node.alternate) walk_template(fragment_nodes(node.alternate), bound, out);
				break;
			case 'EachBlock': {
				add_expression_refs(node.expression, bound, out);
				const each_bound = new Set(bound);
				collect_pattern_names(node.context, each_bound);
				if (node.index) each_bound.add(node.index);
				if (node.key) add_expression_refs(node.key, each_bound, out);
				walk_template(fragment_nodes(node.body), each_bound, out);
				if (node.fallback) walk_template(fragment_nodes(node.fallback), bound, out);
				break;
			}
			case 'AwaitBlock': {
				add_expression_refs(node.expression, bound, out);
				if (node.pending) walk_template(fragment_nodes(node.pending), bound, out);
				if (node.then) {
					const then_bound = new Set(bound);
					if (node.value) collect_pattern_names(node.value, then_bound);
					walk_template(fragment_nodes(node.then), then_bound, out);
				}
				if (node.catch) {
					const catch_bound = new Set(bound);
					if (node.error) collect_pattern_names(node.error, catch_bound);
					walk_template(fragment_nodes(node.catch), catch_bound, out);
				}
				break;
			}
			case 'KeyBlock':
				add_expression_refs(node.expression, bound, out);
				walk_template(fragment_nodes(node.fragment), bound, out);
				break;
			case 'SnippetBlock': {
				const snip_bound = new Set(bound);
				for (const p of node.parameters ?? []) collect_pattern_names(p, snip_bound);
				walk_template(fragment_nodes(node.body), snip_bound, out);
				break;
			}
			case 'Component':
			case 'SvelteComponent': {
				// the component name (`Foo` or `Foo.Bar`) references an import/host binding
				const root = String(node.name || '').split('.')[0];
				if (root && !bound.has(root)) out.add(root);
				add_attribute_refs(node, bound, out);
				const el_bound1 = new Set(bound);
				for (const name of let_directive_names(node)) el_bound1.add(name);
				if (node.fragment) walk_template(fragment_nodes(node.fragment), el_bound1, out);
				break;
			}
			case 'RegularElement':
			case 'SvelteElement':
			case 'SvelteSelf':
			case 'SvelteFragment':
			case 'SvelteBoundary':
			case 'SlotElement':
			case 'TitleElement': {
				if (node.tag) add_expression_refs(node.tag, bound, out); // <svelte:element this={tag}>
				add_attribute_refs(node, bound, out);
				const el_bound = new Set(bound);
				for (const name of let_directive_names(node)) el_bound.add(name);
				if (node.fragment) walk_template(fragment_nodes(node.fragment), el_bound, out);
				break;
			}
			default:
				if (node.fragment) walk_template(fragment_nodes(node.fragment), bound, out);
		}
	}
}

/** Collect all snippet names defined anywhere in a subtree (for cross-boundary error detection). */
export function collectSnippetNames(nodes) {
	const out = new Set();
	const visit = (list) => {
		for (const n of list ?? []) {
			if (n.type === 'SnippetBlock' && n.expression) out.add(n.expression.name);
			for (const k of ['consequent', 'alternate', 'body', 'fallback', 'pending', 'then', 'catch', 'fragment']) {
				if (n[k]?.nodes) visit(n[k].nodes);
			}
		}
	};
	visit(nodes);
	return out;
}

/**
 * @param {any[]} nodes hoisted subtree top-level nodes
 * @returns {Set<string>} free identifier names
 */
export function collectFreeIdentifiers(nodes) {
	const out = new Set();
	walk_template(nodes, new Set(), out);
	return out;
}
