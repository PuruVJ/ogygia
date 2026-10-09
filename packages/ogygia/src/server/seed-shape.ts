/**
 * SEED SHAPING — the server half. The build says which top-level `page.data` keys the islands on a
 * page read (link/page-keys.ts → island-deps handoff → Region records per island); the handle
 * unions those asks per request and ships only that slice of `page.data` in the page seed.
 *
 * The ask is `'all'` whenever ANY region on the page could not be pinned (a promise `of` whose
 * module SSR cannot see, an entry the handoff does not know, a closure that hands `page.data` to
 * a function) — then the seed ships whole, exactly as before shaping existed.
 */

/** What a region asks of the page seed: nothing, everything, or these keys of `page.data`. */
export type SeedAsk = false | 'all' | readonly string[];

/** The request's union of asks: `'all'`, or the key set. (No ask at all = no seed.) */
export type SeedKeys = 'all' | Set<string>;

/** Fold one region's ask into the request's union. */
export function merge_seed_ask(current: SeedKeys | null, ask: SeedAsk): SeedKeys | null {
	if (ask === false) return current;
	if (ask === 'all' || current === 'all') return 'all';
	const next = current ?? new Set<string>();
	for (const k of ask) next.add(k);
	return next;
}

/**
 * The slice of `page.data` to ship. A plain object is picked down to `keys` (present keys only — a
 * key the load never returned stays absent, so `page.data.x` is `undefined` on both legs alike);
 * `'all'`, or a non-object (a load returned nothing, or something exotic), ships as is. A key
 * whose value is a promise stays a promise: the streaming/settling that follows sees the same shape.
 */
export function shape_page_data(data: unknown, keys: SeedKeys | null): unknown {
	if (keys === null || keys === 'all') return data;
	if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
	const src = data as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of keys) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
	return out;
}
