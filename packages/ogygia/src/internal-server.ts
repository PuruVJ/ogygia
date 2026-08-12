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
