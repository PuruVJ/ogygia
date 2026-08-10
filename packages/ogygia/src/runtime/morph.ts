/**
 * Idiomorph-lite: reconcile a live element's children toward a freshly rendered region IN PLACE,
 * instead of tearing the old DOM down and rebuilding it. Live regions (`query.live` ticks) use
 * this so focus, typed-in input values, scroll position, and CSS transitions survive an update —
 * the LiveView "the page breathes" property. It is deliberately small: index-aligned with `id`-based
 * keying, which covers the common tick (same structure, changed text / attributes). It is NOT a
 * general keyed-list differ; interactive islands keep their state through Svelte reactivity (props
 * push), not through morphing.
 *
 * Only attributes are synced on elements — never the live `.value` / `.checked` DOM *properties* —
 * so text a user is typing is not clobbered mid-tick.
 */
import { slots } from './slots.js';

/** Same "slot": same node kind, same tag, and (if either carries an `id`) the same `id`. */
function same_node(a: Node, b: Node): boolean {
	if (a.nodeType !== b.nodeType) return false;
	if (a.nodeType === Node.ELEMENT_NODE) {
		const ea = a as Element;
		const eb = b as Element;
		if (ea.tagName !== eb.tagName) return false;
		const ia = ea.getAttribute('id');
		const ib = eb.getAttribute('id');
		if (ia !== null || ib !== null) return ia === ib;
		return true;
	}
	return true; // text / comment reconcile positionally
}

function sync_attributes(from: Element, to: Element): void {
	const wanted = new Set<string>();
	for (const attr of Array.from(to.attributes)) {
		wanted.add(attr.name);
		if (from.getAttribute(attr.name) !== attr.value) from.setAttribute(attr.name, attr.value);
	}
	for (const attr of Array.from(from.attributes)) {
		if (!wanted.has(attr.name)) from.removeAttribute(attr.name);
	}
}

function morph_node(from: Node, to: Node): void {
	if (from.nodeType === Node.TEXT_NODE || from.nodeType === Node.COMMENT_NODE) {
		if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
		return;
	}
	if (from.nodeType === Node.ELEMENT_NODE) {
		sync_attributes(from as Element, to as Element);
		morph_children(from as Element, Array.from(to.childNodes));
	}
}

/** Morph `parent`'s children toward `new_nodes` (from a detached, freshly parsed region). */
/** Feature entry: fill the `morph` slot (live static-region ticks morph in place). */
export function install() {
	slots.morph = morph_children;
}

export function morph_children(parent: Element, new_nodes: Node[]): void {
	let old_child = parent.firstChild;
	for (const next of new_nodes) {
		if (!old_child) {
			parent.appendChild(document.importNode(next, true));
			continue;
		}
		if (same_node(old_child, next)) {
			morph_node(old_child, next);
			old_child = old_child.nextSibling;
		} else {
			// No compatible node in this slot — insert the new one and keep the old for a later match.
			parent.insertBefore(document.importNode(next, true), old_child);
		}
	}
	while (old_child) {
		const gone = old_child;
		old_child = old_child.nextSibling;
		parent.removeChild(gone);
	}
}
