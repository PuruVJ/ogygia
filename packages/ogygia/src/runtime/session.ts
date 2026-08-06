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

export class RuntimeSession {
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
