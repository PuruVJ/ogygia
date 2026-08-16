/**
 * The brand marking a held-region value (`region()` results / deferred tickets). It lives ALONE, with
 * no imports, on purpose: the client transport hook only needs to TEST `value[REGION_BRAND]` to know
 * whether to decode a region — and importing that test from `region.js` used to drag the whole
 * `region → region-snippet → svelte/server` graph (~20kB) into every client that installs the hook.
 * `Symbol.for` so every bundle (server render, client hook, runtime) agrees on one brand.
 */
export const REGION_BRAND: unique symbol = Symbol.for('ogygia.region') as never;
