/**
 * The worker/SSR-safe region PRIMITIVES — `region()`, `isRegion`, `og_html_region` — WITHOUT the client
 * `Region.svelte` (which imports `virtual:ogygia/*` + the runtime that touches `window`, and so can't be
 * bundled into a Web Worker). A REPL that renders held regions during a worker SSR pass imports this
 * instead of the `ogygia` / `ogygia/internal` barrels. `region()` on a plain component takes the inline
 * path (no signer, no node:crypto) — see region.ts — so held-raw regions render as zero-JS server HTML.
 */
export { region, isRegion, og_html_region } from './region.js';
