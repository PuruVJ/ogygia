/**
 * Document-scoped runtime session: lake caches, seed flags, kit-page probe, server-island gate.
 * Cleared on SPA body swap via `reset()` so connecting regions never see the previous page.
 */
import { ConcurrencyGate } from './concurrency.js';
import { FROZEN_SELECTOR } from './region-attrs.js';

/** Soft cap on lake cache entries (unique lake ids). Evict oldest insertion on overflow. */
const LAKE_CACHE_MAX = 64;

/** Cached SSR DOM (+ optional SWR endpoint) for `{#if}` remount of hydrate:none regions.
 * Keyed by lake entry id — size is O(unique lakes on the page), not O(toggles).
 * Cleared on SPA body swap via `reset()`. SWR refresh replaces the entry (does not grow). */
export type LakeCacheEntry = {
	frag: Node;
	endpoint: string;
	when: string;
	/** `Date.now()` when this entry was first cached or last successfully revalidated. */
	cachedAt: number;
	/** Client TTL in ms; `0` = no expiry. */
	maxAgeMs: number;
};

/**
 * WHO OWNS EACH NODE IN `<head>` — the rule every head write and removal follows.
 *
 *   - The PAGE owns the head the server sent and everything the router or the runtime puts there for
 *     the page (merged heads, hoisted region sheets, preload links, hints). A navigation replaces
 *     page-owned nodes, and only those.
 *   - An ISLAND owns what its `<svelte:head>` renders live (csr=false: the island hydrates alone, so
 *     its head block renders fresh — hydrate-core.ts `neutralize_head_hydration_markers`). Only the
 *     island's own teardown removes those: Svelte deletes a head block by walking from its first node
 *     to its last, and if anyone else removes the last one first, the walk runs to the end of <head>
 *     and deletes the next page's tags with it (field: description / canonical / og:* gone after a
 *     client navigation).
 *   - Anything else (a third-party or dev-tooling inject) is not ours and is never removed — the rule
 *     SvelteKit's own router follows.
 *
 * And ONE copy: while an island's head content is live, the page's identical server copy of it is
 * retired (field: two identical JSON-LD blocks, duplicated inline CSS and preloads). Only page-owned
 * copies are ever retired — never an island's live node — and never a stylesheet link (removing either
 * copy could unstyle the page for a frame; a doubled sheet is harmless).
 */
const STYLESHEET_REL_RE = /(?:^|\s)stylesheet(?:\s|$)/i;

export class RuntimeSession {
	/** Page-owned head nodes (see above). Survives `reset()`: it is the document's, not a page's. */
	readonly page_head = new WeakSet<Node>();
	/** Island-owned head ELEMENTS still to watch (pruned when they leave the document). */
	readonly island_head = new Set<Element>();

	/** Mark a node this document's page owns (the router / runtime inserted it for the page). */
	claim_page_head(node: Node): void {
		this.page_head.add(node);
	}

	/** At boot: everything already in <head> came from the server — the page owns it. */
	adopt_document_head(): void {
		if (typeof document === 'undefined') return;
		for (const n of document.head.childNodes) this.page_head.add(n);
	}

	/** After an island's hydrate: the head elements it added (not in `before`, not page-owned) are
	 *  that island's; then retire the page's copies of them. */
	record_island_head(before: ReadonlySet<Node>): void {
		for (const n of document.head.children) {
			if (!before.has(n) && !this.page_head.has(n)) this.island_head.add(n);
		}
		this.retire_page_head_copies();
	}

	/**
	 * Remove every PAGE-owned head element that duplicates a live island-owned one (same markup), and
	 * the page's `<title>` once an island renders its own (the browser honours the first title, and
	 * the island's is the reactive one). Runs after an island hydrates and after a navigation merge.
	 */
	retire_page_head_copies(): void {
		const live = new Set<string>();
		let island_title = false;
		for (const el of this.island_head) {
			if (!el.isConnected) {
				this.island_head.delete(el);
				continue;
			}
			live.add(el.outerHTML);
			if (el.localName === 'title') island_title = true;
		}
		if (live.size === 0) return;
		for (const el of Array.from(document.head.children)) {
			if (!this.page_head.has(el)) continue;
			if (el.localName === 'link' && STYLESHEET_REL_RE.test(el.getAttribute('rel') ?? '')) continue;
			if ((island_title && el.localName === 'title') || live.has(el.outerHTML)) el.remove();
		}
	}

	readonly lake_cache = new Map<string, LakeCacheEntry>();
	readonly settled_lakes = new WeakSet<Element>();
	readonly initialized_lakes = new Set<string>();
	readonly server_gate = new ConcurrencyGate(3);

	#remote_seeded = false;
	#page_seeded = false;
	#kit_page: boolean | undefined;

	get remote_seeded() {
		return this.#remote_seeded;
	}
	mark_remote_seeded() {
		this.#remote_seeded = true;
	}

	get page_seeded() {
		return this.#page_seeded;
	}
	mark_page_seeded() {
		this.#page_seeded = true;
	}

	get kit_page() {
		return this.#kit_page;
	}
	set kit_page(v: boolean | undefined) {
		this.#kit_page = v;
	}

	/** Insert/replace a lake cache entry; evict oldest if over LAKE_CACHE_MAX. */
	set_lake_cache(id: string, entry: LakeCacheEntry) {
		if (this.lake_cache.has(id)) this.lake_cache.delete(id);
		this.lake_cache.set(id, entry);
		while (this.lake_cache.size > LAKE_CACHE_MAX) {
			const oldest = this.lake_cache.keys().next().value;
			if (oldest == null) break;
			this.lake_cache.delete(oldest);
		}
	}

	settle_lakes_in(root: ParentNode) {
		if (root instanceof Element && root.matches?.(FROZEN_SELECTOR)) {
			this.settled_lakes.add(root);
		}
		for (const lake of root.querySelectorAll(FROZEN_SELECTOR)) {
			this.settled_lakes.add(lake);
		}
	}

	reset() {
		this.#kit_page = undefined;
		this.#remote_seeded = false;
		this.#page_seeded = false;
		this.lake_cache.clear();
		this.initialized_lakes.clear();
	}
}

/** Process-wide session for the islands runtime (one client module graph). */
export const runtime_session = new RuntimeSession();
