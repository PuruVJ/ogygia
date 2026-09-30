/**
 * Internal server-only region helpers used on the SSR / region-endpoint graph.
 *
 * **Not a public API** — do not import from app code.
 *
 * @packageDocumentation
 * @internal
 */
/** Signer for deferred regions — SSR-only (the client region binding never imports this). */
export { makeRegionEndpoint } from './server/region-endpoint.js';
/** A held region's server render to HTML — the one copy every region binding calls. */
export { render_region_html } from './server/render-region-html.js';
