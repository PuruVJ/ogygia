/** SSR-resolved remote response maps shared by Kit remote-functions + ogygia SPA reset. */
type RemoteNode = { v?: unknown; e?: [number, unknown] };

type RemoteResource = { destroy?: () => void };
type RemoteEntry = { resource?: RemoteResource };

/**
 * Kit remote-function response + instance cache.
 *
 * SSR seeds (`query_responses`) are cleared in `prepare_spa_document` (before
 * replaceWith). Instance maps are cleared in `finish_spa_document` (after
 * replaceWith, before async island hydrate) so a new page never reuses a
 * LiveQuery whose `#start` is already spent — Kit's `once()` wrapper would
 * never open SSE again, leaving `query.live` on "connecting…".
 */
export class RemoteCache {
	readonly query_responses: Record<string, RemoteNode> = {};
	readonly prerender_responses: Record<string, RemoteNode> = {};
	readonly query_map = new Map<string, Map<string, RemoteEntry>>();
	readonly live_query_map = new Map<string, Map<string, RemoteEntry>>();

	/** Drop SSR seed bags only (safe while old islands are still connected). */
	clear_seeds(): void {
		for (const k of Object.keys(this.query_responses)) delete this.query_responses[k];
		for (const k of Object.keys(this.prerender_responses)) delete this.prerender_responses[k];
	}

	/**
	 * Destroy leftover query/live instances and clear the maps.
	 * Call only after the previous body has disconnected.
	 */
	clear_instances(): void {
		destroy_map(this.query_map);
		destroy_map(this.live_query_map);
		this.query_map.clear();
		this.live_query_map.clear();
	}
}

function destroy_map(map: Map<string, Map<string, RemoteEntry>>) {
	for (const entries of map.values()) {
		for (const entry of entries.values()) {
			try {
				entry.resource?.destroy?.();
			} catch {
				/* already torn down */
			}
		}
	}
}

const GLOBAL_KEY = '__ogygia_remote_cache__';

/**
 * Process-wide singleton on `globalThis`.
 * Vite can load this file under multiple resolved ids (`/@fs/…` vs absolute, runtime
 * chunk vs island graph); module-level `new RemoteCache()` would then create separate
 * maps, so SPA `clear_*` would miss the maps Kit's LiveQuery actually uses.
 */
function get_remote_cache(): RemoteCache {
	const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: RemoteCache };
	if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new RemoteCache();
	return g[GLOBAL_KEY];
}

export const remote_cache = get_remote_cache();

export const query_responses = remote_cache.query_responses;
export const prerender_responses = remote_cache.prerender_responses;
export const query_map = remote_cache.query_map;
export const live_query_map = remote_cache.live_query_map;

export function clear_remote_seeds(): void {
	remote_cache.clear_seeds();
}

export function clear_remote_instances(): void {
	remote_cache.clear_instances();
}
