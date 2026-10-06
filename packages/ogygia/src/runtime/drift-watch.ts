/**
 * WHICH SLEEPING ISLANDS WERE TOUCHED. An island keeps its server markup from its first connect and,
 * at its wake, used to parse that copy and walk it against the live DOM (hydrate-core
 * `repair_if_drifted`) — every island, though almost always nothing had touched it: two thirds of
 * Svelte's own hydrate time on a page of heavy islands, measured. One `MutationObserver` over the
 * document now marks an island CHANGED when a node or a text in it changes (the comparison ignores
 * attributes, and so does this); the wake runs the comparison, and the repair, only for a changed
 * one. Nothing is decided by timing: the wake takes the observer's pending records first.
 *
 * The observer runs only while some island sleeps with a copy (a page whose islands are all awake
 * pays nothing for later DOM work). An island that leaves the document while it sleeps is marked
 * changed: nothing watched it meanwhile. A browser without MutationObserver: every island compares,
 * as before.
 */

import { walk_enters } from './ownership.js';

const REGION = 'ogygia-region';
const changed = new WeakSet<Element>();
let observer: MutationObserver | null = null;
let sleeping = 0;
const supported = typeof MutationObserver !== 'undefined';

function mark(records: MutationRecord[]): void {
	for (const r of records) {
		// Every region the change sits in (a change deep in a nested island changes its host's sequence
		// too) — unless, between the change and that region, an element sits whose inside Svelte's walk
		// never reads (runtime/ownership.ts: `{@html}` / static / kept / a slot / a hydrated region). A
		// web component reworking its own light DOM there is not the island drifting, and arming the
		// repair for it would only cost a comparison that finds nothing to do.
		let hidden = false;
		for (let n: Node | null = r.target; n; n = n.parentNode) {
			if (n.nodeType !== 1) continue;
			const el = n as Element;
			if (el.localName === REGION && !hidden) changed.add(el);
			if (!hidden && !walk_enters(el)) hidden = true;
		}
	}
}

/** A region kept its server copy: watch until it wakes (pair with {@link unwatch_region}). */
export function watch_region(): void {
	if (!supported || ++sleeping > 1) return;
	observer ??= new MutationObserver(mark);
	observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
}

/** A region woke (or left): stop watching once none sleeps. */
export function unwatch_region(): void {
	if (!supported || sleeping === 0 || --sleeping > 0) return;
	if (observer) mark(observer.takeRecords());
	observer?.disconnect();
}

/** The region's copy is stale (it left the document while it slept): compare it at the wake. */
export function mark_region_changed(region: Element): void {
	changed.add(region);
}

/** Was anything in this region's markup touched since it kept its copy? Read at the wake, BEFORE the
 *  runtime itself edits the island (lakes lifted): the pending records are taken first. */
export function region_changed(region: Element): boolean {
	if (!supported) return true;
	if (observer && sleeping > 0) mark(observer.takeRecords());
	return changed.has(region);
}
