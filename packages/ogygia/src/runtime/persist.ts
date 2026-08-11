/**
 * `data-ogygia-keep="key"` — keep matching layout chrome across SPA body swaps.
 *
 * Same key on outgoing + incoming body → the live node is moved into the new tree
 * (SSR markup for that key is discarded). Custom elements inside are marked so
 * `disconnectedCallback` does not unmount during the move.
 *
 * Only top-level persist nodes (not nested inside another persist ancestor).
 * First duplicate key wins; later duplicates are ignored.
 */
import { slots } from './slots.js';

/**
 * Feature entry: fill the `persist` slot (router relocates matching chrome; core keeps a relocating
 * island mounted). A persist island hydrates through `LiveHost` (the `live` slot) so the next page
 * can push fresh props into the relocated app — persist declares `live` as a build dep so that slot
 * is always filled, without this module importing the Svelte component (keeps it unit-testable).
 */
export function install() {
	slots.persist = {
		is_persist_preserving,
		collect: collect_persist_pairs,
		relocate: relocate_persist_pairs,
		end: end_persist_preserve
	};
}

export const KEEP_ATTR = 'data-ogygia-keep';

const preserving = new WeakSet<Element>();

export function is_persist_preserving(el: Element): boolean {
	return preserving.has(el);
}

/** Top-level `[data-ogygia-keep]` nodes keyed by attribute value. */
export function index_top_level_persist(root: ParentNode): Map<string, Element> {
	const map = new Map<string, Element>();
	for (const el of root.querySelectorAll(`[${KEEP_ATTR}]`)) {
		const key = el.getAttribute(KEEP_ATTR)?.trim() ?? '';
		if (!key || map.has(key)) continue;
		if (el.parentElement?.closest(`[${KEEP_ATTR}]`)) continue;
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
		// CONTINUITY: a persisted ISLAND relocates its live app; feed it the incoming page's props
		// (read from `next` while it still sits in the parsed doc with its props sibling) so a
		// persisted component reflects the new route instead of freezing at first-mount props.
		const absorb = (live as unknown as { absorbPersistProps?: (n: Element) => void })
			.absorbPersistProps;
		if (typeof absorb === 'function') absorb.call(live, next);
		next.replaceWith(live);
	}
}

export function end_persist_preserve(pairs: PersistPair[]) {
	for (const { live } of pairs) unmark_tree(live);
}
