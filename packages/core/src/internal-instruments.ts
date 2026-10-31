/**
 * The runtime's measurement internals the devtools dock and the profiler read (`@ogygia/devtools`):
 * the beacon, the props sidecar, the page seeds, render-blocking, the islands' own cost, the tools'
 * own fetches, the page-defer keys, the island graph and unscoped-css.
 *
 * **Not a public API** — do not import from app code.
 *
 * @packageDocumentation
 * @internal
 */
export {
	beacon_record_cpu,
	beacon_page,
	hole_request_times,
	is_headless,
	type AttrChange,
	type BeaconPage
} from './runtime/beacon.ts';
export { props_sidecar_of } from './runtime/sidecar.ts';
export { PAGE_SEED_SELECTOR } from './runtime/seeds.ts';
export { paint_blocker } from './runtime/render-blocking.ts';
export type { RegionRefusal } from './runtime/region-endpoint-url.ts';
export { charge, own_cost } from './runtime/own-cost.ts';
export { nearest_attr } from './runtime/nearest-attr.ts';
export { REGION_RENDER_CONCURRENCY } from './runtime/concurrency.ts';
export { tool_fetch, tool_made } from './tool-fetches.ts';
export { PAGE_DEFER_KEY, PAGE_DEFER_GLOBAL, PAGE_DEFER_REGISTRY_KEY } from './page-defer.ts';
export { ISLAND_GRAPH_ATTR, decode_island_graph } from './island-graph.ts';
export {
	find_unscoped,
	unscoped_finding,
	unscoped_marker,
	type UnscopedStyles
} from './unscoped-css.ts';
