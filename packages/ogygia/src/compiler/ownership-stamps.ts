/**
 * OWNERSHIP STAMPS — declared, not inferred (internal/notes/dom-ownership.md §4).
 *
 * The runtime's pre-hydration repair keeps an island's DOM in the shape Svelte's hydration walk
 * binds by position, and must leave alone what the walk never reads — but the runtime cannot tell the
 * two apart from the DOM: Svelte's PROD output opens an `{@html}` block with the same `<!---->` it uses
 * as a separator everywhere. The compiler can. This server-leg pass stamps `data-og-opaque` on the
 * element shapes whose CHILDREN Svelte's hydration never walks (svelte 5 client: `html.js`,
 * `RegularElement.js`, `fragment.js` `is_static_element`):
 *
 *  - an element whose only non-whitespace child is `{@html}` — the controlled form: the walk takes the
 *    element and never descends;
 *  - an element with `bind:innerHTML` / `bind:textContent` / `bind:innerText` — Svelte owns its
 *    content wholesale, by value, not by walking it;
 *  - a custom element whose descendants are all static (no expression, block, component, render tag,
 *    `{@html}` or directive, only literal attributes) — Svelte keeps a reference to the host and never
 *    descends its children.
 *
 * A web component living there can rework its own light DOM before the island wakes and the repair,
 * the drift watch and the morph leave it alone (runtime/ownership.ts). The stamp is an attribute on
 * the SERVER render only: hydration never compares or strips static attributes, it adds no node (a
 * node would shift the positional walk), and the client template is untouched.
 */
import { parse } from 'svelte/compiler';
import MagicString from 'magic-string';
import { blank_styles } from './blank-styles.js';
// the runtime's reader and this writer share the constants
import { HTML_PARENT_ATTR, OPAQUE_ATTR } from '../runtime/ownership.js';

/** A cheap presence test before parsing: one of the three shapes could be in this file. */
const MAY_STAMP_RE =
	/\{@html|bind:(?:innerHTML|textContent|innerText)|<[a-z][\w.]*-[\w-]*[\s/>]|\sis=/;
const WHOLESALE_BINDS = new Set(['innerHTML', 'textContent', 'innerText']);
/** Template node kinds that make content dynamic (anything Svelte must walk to bind). */
const DYNAMIC_KINDS = new Set([
	'ExpressionTag',
	'HtmlTag',
	'RenderTag',
	'ConstTag',
	'DebugTag',
	'AttachTag',
	'IfBlock',
	'EachBlock',
	'AwaitBlock',
	'KeyBlock',
	'SnippetBlock',
	'Component',
	'SvelteComponent',
	'SvelteElement',
	'SvelteSelf',
	'SvelteFragment',
	'SvelteBoundary',
	'SlotElement'
]);

type Node = { type: string; start: number; end: number; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const is_blank = (n: Node) => n.type === 'Text' && !String(n.data ?? '').trim();

/** Every attribute on an element is a plain literal (no `{expr}`), and it carries no directive. */
function literal_attributes(el: Node): boolean {
	for (const a of el.attributes ?? []) {
		if (a.type !== 'Attribute') return false; // directives, spreads, attach tags
		const v = a.value;
		if (v === true) continue;
		const parts = Array.isArray(v) ? v : [v];
		if (parts.some((p: Node) => p.type !== 'Text')) return false;
	}
	return true;
}

/** Every descendant of `nodes` is static: plain text, comments, elements with literal attributes. */
function all_static(nodes: Node[]): boolean {
	for (const n of nodes) {
		if (n.type === 'Text' || n.type === 'Comment') continue;
		if (DYNAMIC_KINDS.has(n.type)) return false;
		if (n.type !== 'RegularElement') return false;
		if (!literal_attributes(n)) return false;
		if (!all_static(n.fragment?.nodes ?? [])) return false;
	}
	return true;
}

function is_custom_element(el: Node): boolean {
	return (
		String(el.name).includes('-') ||
		(el.attributes ?? []).some((a: Node) => a.type === 'Attribute' && a.name === 'is')
	);
}

/** Does Svelte's hydration walk never enter this element's children? */
function opaque(el: Node): boolean {
	if ((el.attributes ?? []).some((a: Node) => a.type === 'Attribute' && a.name === OPAQUE_ATTR))
		return false; // already stamped
	const kids: Node[] = (el.fragment?.nodes ?? []).filter((n: Node) => !is_blank(n));
	if (kids.length === 1 && kids[0].type === 'HtmlTag') return true;
	if (
		(el.attributes ?? []).some(
			(a: Node) => a.type === 'BindDirective' && WHOLESALE_BINDS.has(a.name)
		)
	)
		return true;
	return is_custom_element(el) && all_static(el.fragment?.nodes ?? []);
}

const CHILD_KEYS = [
	'fragment',
	'consequent',
	'alternate',
	'body',
	'pending',
	'then',
	'catch',
	'fallback'
];

/**
 * `source` with every opaque element stamped, or `null` when there is nothing to stamp (or the file
 * does not parse — the real compile reports that). Outermost wins: nothing is stamped inside a stamped
 * element (the repair never enters it anyway).
 */
export function stamp_opaque(source: string, filename: string): string | null {
	if (!MAY_STAMP_RE.test(source)) return null;
	let ast: Node;
	try {
		ast = parse(blank_styles(source), { modern: true, filename }) as unknown as Node;
	} catch {
		return null;
	}
	const at: { pos: number; attr: string }[] = [];
	const visit = (nodes: Node[] | undefined) => {
		for (const n of nodes ?? []) {
			if (n.type === 'RegularElement' && opaque(n)) {
				at.push({ pos: n.start + 1 + String(n.name).length, attr: OPAQUE_ATTR });
				continue;
			}
			// an `{@html}` BESIDE other children: its parent stays walked, but the child elements it
			// produced must not be entered (see HTML_PARENT_ATTR)
			if (
				n.type === 'RegularElement' &&
				(n.fragment?.nodes ?? []).some((c: Node) => c.type === 'HtmlTag') &&
				!(n.attributes ?? []).some(
					(a: Node) =>
						a.type === 'Attribute' && (a.name === HTML_PARENT_ATTR || a.name === OPAQUE_ATTR)
				)
			)
				at.push({ pos: n.start + 1 + String(n.name).length, attr: HTML_PARENT_ATTR });
			for (const k of CHILD_KEYS) {
				const child = n[k];
				if (child && Array.isArray(child.nodes)) visit(child.nodes);
			}
		}
	};
	visit(ast.fragment?.nodes);
	if (!at.length) return null;
	const s = new MagicString(source);
	for (const { pos, attr } of at) s.appendLeft(pos, ' ' + attr);
	return s.toString();
}
