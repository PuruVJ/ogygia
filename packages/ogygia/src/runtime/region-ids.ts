/**
 * R3 OWNERSHIP: which page-scoped hub ids each region's island resolved during hydration. The
 * hydrate core installs a resolve-sink (ref.set_resolve_sink) around each island's sync prop +
 * context decode that funnels ids here, keyed by the region element; the reconciler (a navigation)
 * disposes exactly the ids of REMOVED regions. WeakMap → a removed element's set is GC'd with it.
 * Its own module so the boot-time reconciler and the lazily loaded hydrate core share one map
 * without either importing the other.
 */
import { set_resolve_sink } from '../ref.js';

const owned_ids = new WeakMap<Element, Set<string>>();

/** Record that `region`'s island resolved page id `id` (called via the resolve-sink). */
export function record_region_id(region: Element, id: string): void {
	let set = owned_ids.get(region);
	if (set === undefined) owned_ids.set(region, (set = new Set()));
	set.add(id);
}

/** The page ids a region's island owns, or undefined. */
export function region_owned_ids(region: Element): Set<string> | undefined {
	return owned_ids.get(region);
}

/** Run `fn` with the hub's resolve-sink funneling every page id it resolves to `region`'s owned
 *  set, then restore the previous sink (finally, so a throw can't strand it). Wrap an island's
 *  SYNC prop/context decode so the reconciler learns which ids that island owns. */
export function capture_region_ids<T>(region: Element, fn: () => T): T {
	set_resolve_sink((id) => record_region_id(region, id));
	try {
		return fn();
	} finally {
		set_resolve_sink(null);
	}
}
