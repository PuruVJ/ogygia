/**
 * `data-ogygia-persist="key"` — keep matching layout chrome across SPA body swaps.
 *
 * Same key on outgoing + incoming body → the live node is moved into the new tree
 * (SSR markup for that key is discarded). Custom elements inside are marked so
 * `disconnectedCallback` does not unmount during the move.
 *
 * Only top-level persist nodes (not nested inside another persist ancestor).
 * First duplicate key wins; later duplicates are ignored.
 */
export const PERSIST_ATTR = 'data-ogygia-persist';

const preserving = new WeakSet<Element>();

export function is_persist_preserving(el: Element): boolean {
	return preserving.has(el);
}

/** Top-level `[data-ogygia-persist]` nodes keyed by attribute value. */
export function index_top_level_persist(root: ParentNode): Map<string, Element> {
	const map = new Map<string, Element>();
	for (const el of root.querySelectorAll(`[${PERSIST_ATTR}]`)) {
		const key = el.getAttribute(PERSIST_ATTR)?.trim() ?? '';
		if (!key || map.has(key)) continue;
		if (el.parentElement?.closest(`[${PERSIST_ATTR}]`)) continue;
		map.set(key, el);
	}
	return map;
}

export type PersistPair = { live: Element; next: Element };

/** Pairs whose key exists on both sides (live = current document, next = incoming). */
export function collect_persist_pairs(from: ParentNode, to: ParentNode): PersistPair[] {
	const old_map = index_top_level_persist(from);
	const new_map = index_top_level_persist(to);
	const pairs: PersistPair[] = [];
	for (const [key, live] of old_map) {
		const next = new_map.get(key);
		if (next && next !== live) pairs.push({ live, next });
	}
	return pairs;
}

function mark_tree(live: Element) {
	if (live.localName === 'ogygia-region') preserving.add(live);
	for (const r of live.querySelectorAll('ogygia-region')) preserving.add(r);
}

function unmark_tree(live: Element) {
	preserving.delete(live);
	for (const r of live.querySelectorAll('ogygia-region')) preserving.delete(r);
}

/**
 * Move live nodes onto incoming placeholders. Call while `next` still sits in the
 * parsed document (before `document.body.replaceWith`). Marks regions so disconnect
 * does not unmount; caller must `end_persist_preserve` after the new body connects.
 */
export function relocate_persist_pairs(pairs: PersistPair[]) {
	for (const { live, next } of pairs) {
		mark_tree(live);
		next.replaceWith(live);
	}
}

export function end_persist_preserve(pairs: PersistPair[]) {
	for (const { live } of pairs) unmark_tree(live);
}
