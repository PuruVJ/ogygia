/** SSR-resolved remote response maps shared by Kit remote-functions + ogygia SPA reset. */
type RemoteNode = { v?: unknown; e?: [number, unknown] };

/**
 * Kit remote-function response + instance cache. Cleared on SPA document swap so
 * page B never sees page A's seeded queries.
 */
export class RemoteCache {
	readonly query_responses: Record<string, RemoteNode> = {};
	readonly prerender_responses: Record<string, RemoteNode> = {};
	readonly query_map = new Map();
	readonly live_query_map = new Map();

	clear(): void {
		for (const k of Object.keys(this.query_responses)) delete this.query_responses[k];
		for (const k of Object.keys(this.prerender_responses)) delete this.prerender_responses[k];
		this.query_map.clear();
		this.live_query_map.clear();
	}
}

/** Process-wide singleton — Kit remote-functions import these as module bindings. */
export const remote_cache = new RemoteCache();

export const query_responses = remote_cache.query_responses;
export const prerender_responses = remote_cache.prerender_responses;
export const query_map = remote_cache.query_map;
export const live_query_map = remote_cache.live_query_map;

export function clear_remote_responses(): void {
	remote_cache.clear();
}
