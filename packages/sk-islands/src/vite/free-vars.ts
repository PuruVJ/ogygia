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
function collectPatternNames(node, out) {
	if (!node) return;
	switch (node.type) {
		case 'Identifier':
			out.add(node.name);
			break;
		case 'ObjectPattern':
			for (const prop of node.properties) {
				if (prop.type === 'RestElement') collectPatternNames(prop.argument, out);
				else collectPatternNames(prop.value, out);
			}
			break;
		case 'ArrayPattern':
			for (const el of node.elements) collectPatternNames(el, out);
			break;
		case 'AssignmentPattern':
			collectPatternNames(node.left, out);
			break;
		case 'RestElement':
			collectPatternNames(node.argument, out);
			break;
	}
}

/** Is this Identifier node a *reference* (a read) rather than a binding/property name? */
function isReference(node, parent, key) {
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
 * JS function scopes and not in `svelteBound`) into `out`.
 */
function addExpressionRefs(expr, svelteBound, out) {
	if (!expr) return;
	const scopes = [new Set()];
	const has = (name) => {
		if (svelteBound.has(name)) return true;
		for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return true;
		return false;
	};
	walk(expr, {
		enter(node, parent, key) {
			if (FUNCTION_TYPES.has(node.type)) {
				const s = new Set();
				if (node.id && node.type !== 'ArrowFunctionExpression') s.add(node.id.name);
				for (const p of node.params) collectPatternNames(p, s);
				scopes.push(s);
			} else if (node.type === 'BlockStatement' && !FUNCTION_TYPES.has(parent?.type)) {
				scopes.push(new Set());
			} else if (node.type === 'VariableDeclarator') {
				collectPatternNames(node.id, scopes[scopes.length - 1]);
			} else if (node.type === 'CatchClause' && node.param) {
				collectPatternNames(node.param, scopes[scopes.length - 1]);
			} else if (node.type === 'Identifier' && isReference(node, parent, key)) {
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
function letDirectiveNames(node) {
	const names = new Set();
	for (const attr of node.attributes ?? []) {
		if (attr.type === 'LetDirective') {
			if (attr.expression) collectPatternNames(attr.expression, names);
			else names.add(attr.name);
		}
	}
	return names;
}

/** Walk attribute expressions of an element/component (not `let:`, which binds). */
function addAttributeRefs(node, bound, out) {
	for (const attr of node.attributes ?? []) {
		switch (attr.type) {
			case 'Attribute':
				if (attr.value === true) break; // boolean attribute
				if (Array.isArray(attr.value)) {
					for (const part of attr.value) {
						if (part.type === 'ExpressionTag') addExpressionRefs(part.expression, bound, out);
					}
				} else if (attr.value?.type === 'ExpressionTag') {
					// single-expression attribute: `a={x}` or shorthand `{x}`
					addExpressionRefs(attr.value.expression, bound, out);
				}
				break;
			case 'SpreadAttribute':
				addExpressionRefs(attr.expression, bound, out);
				break;
			case 'LetDirective':
				break;
			default:
				// Bind/On/Class/Style/Transition/Animate/Use/In/Out directives
				if (attr.expression) addExpressionRefs(attr.expression, bound, out);
		}
	}
}

/** Collect snippet names + const-declared names defined at this fragment level. */
function siblingBindings(nodes) {
	const names = new Set();
	for (const n of nodes) {
		if (n.type === 'SnippetBlock' && n.expression) names.add(n.expression.name);
		else if (n.type === 'ConstTag') {
			for (const d of n.declaration.declarations) collectPatternNames(d.id, names);
		}
	}
	return names;
}

function fragmentNodes(fragment) {
	return fragment?.nodes ?? [];
}

/**
 * @param {any[]} nodes top-level nodes of the subtree
 * @param {Set<string>} outerBound names bound outside (usually empty at entry)
 * @param {Set<string>} out accumulates free references
 * @param {(name:string)=>void} [onSnippet] called with snippet names defined here (for error reporting)
 */
function walkTemplate(nodes, outerBound, out) {
	const bound = new Set(outerBound);
	for (const name of siblingBindings(nodes)) bound.add(name);

	for (const node of nodes) {
		switch (node.type) {
			case 'Text':
			case 'Comment':
				break;
			case 'ExpressionTag':
			case 'HtmlTag':
			case 'RenderTag':
				addExpressionRefs(node.expression, bound, out);
				break;
			case 'ConstTag':
				for (const d of node.declaration.declarations) addExpressionRefs(d.init, bound, out);
				break;
			case 'IfBlock':
				addExpressionRefs(node.test, bound, out);
				walkTemplate(fragmentNodes(node.consequent), bound, out);
				if (node.alternate) walkTemplate(fragmentNodes(node.alternate), bound, out);
				break;
			case 'EachBlock': {
				addExpressionRefs(node.expression, bound, out);
				const eachBound = new Set(bound);
				collectPatternNames(node.context, eachBound);
				if (node.index) eachBound.add(node.index);
				if (node.key) addExpressionRefs(node.key, eachBound, out);
				walkTemplate(fragmentNodes(node.body), eachBound, out);
				if (node.fallback) walkTemplate(fragmentNodes(node.fallback), bound, out);
				break;
			}
			case 'AwaitBlock': {
				addExpressionRefs(node.expression, bound, out);
				if (node.pending) walkTemplate(fragmentNodes(node.pending), bound, out);
				if (node.then) {
					const thenBound = new Set(bound);
					if (node.value) collectPatternNames(node.value, thenBound);
					walkTemplate(fragmentNodes(node.then), thenBound, out);
				}
				if (node.catch) {
					const catchBound = new Set(bound);
					if (node.error) collectPatternNames(node.error, catchBound);
					walkTemplate(fragmentNodes(node.catch), catchBound, out);
				}
				break;
			}
			case 'KeyBlock':
				addExpressionRefs(node.expression, bound, out);
				walkTemplate(fragmentNodes(node.fragment), bound, out);
				break;
			case 'SnippetBlock': {
				const snipBound = new Set(bound);
				for (const p of node.parameters ?? []) collectPatternNames(p, snipBound);
				walkTemplate(fragmentNodes(node.body), snipBound, out);
				break;
			}
			case 'Component':
			case 'SvelteComponent': {
				// the component name (`Foo` or `Foo.Bar`) references an import/host binding
				const root = String(node.name || '').split('.')[0];
				if (root && !bound.has(root)) out.add(root);
				addAttributeRefs(node, bound, out);
				const elBound1 = new Set(bound);
				for (const name of letDirectiveNames(node)) elBound1.add(name);
				if (node.fragment) walkTemplate(fragmentNodes(node.fragment), elBound1, out);
				break;
			}
			case 'RegularElement':
			case 'SvelteElement':
			case 'SvelteSelf':
			case 'SvelteFragment':
			case 'SvelteBoundary':
			case 'SlotElement':
			case 'TitleElement': {
				if (node.tag) addExpressionRefs(node.tag, bound, out); // <svelte:element this={tag}>
				addAttributeRefs(node, bound, out);
				const elBound = new Set(bound);
				for (const name of letDirectiveNames(node)) elBound.add(name);
				if (node.fragment) walkTemplate(fragmentNodes(node.fragment), elBound, out);
				break;
			}
			default:
				if (node.fragment) walkTemplate(fragmentNodes(node.fragment), bound, out);
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
	walkTemplate(nodes, new Set(), out);
	return out;
}
