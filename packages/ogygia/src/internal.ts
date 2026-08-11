/**
 * Internal wrappers the compile-time transform emits into host/island modules.
 *
 * **Not a public API** — do not import from app code. Prefer authoring regions with
 * `with { wake | render | preset }` and the public exports from `ogygia`.
 *
 * One `Region` renders every placement (island / server / lake) and every held value. Server-island
 * minting is routed through the client-stubbed `virtual:ogygia/region-endpoint` virtual, so `Region`
 * lives in the main graph without leaking `$app/server`.
 *
 * @packageDocumentation
 * @internal
 */
export { default as Region } from './Region.svelte';
export { isNested, setNested } from './context.js';

// Transportable-class registration. Generated code appended to app modules imports
// `__register_transportable` from here (a re-export barrel — tree-shaking drops the
// component exports above, so tagging a plain `.svelte.ts` state file never pulls island
// component code into its chunk).
export { __register_transportable } from './live-transport.js';
export { __tag_context } from './context-bridge.js';
