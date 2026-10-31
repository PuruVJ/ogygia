/**
 * Internal server-only region helpers used on the SSR / region-endpoint graph.
 *
 * **Not a public API** — do not import from app code.
 *
 * @packageDocumentation
 * @internal
 */
/** Signer for deferred regions — SSR-only (the client region binding never imports this). */
export { makeRegionEndpoint } from './server/region-endpoint.ts';
/** A held region's server render to HTML — the one copy every region binding calls. */
export { render_region_html } from './server/render-region-html.ts';
/** What the profiler (`@ogygia/devtools`) reads off a request ogygia served. */
export {
	hole_stats_of,
	record_request_stats,
	request_stats_of,
	set_batch_hole_listener,
	set_request_stats_detail,
	type BatchHoleStats,
	type HoleRequestStats,
	type HoleStat,
	type IslandInteractivity,
	type IslandStat,
	type OgygiaRequestStats,
	type SeedKeyStat
} from './server/request-stats.ts';
export { mark_personal } from './server/personal-response.ts';
export { islands_endpoint } from './server/endpoint.ts';
export { scanRegions } from './server/split-regions.ts';
