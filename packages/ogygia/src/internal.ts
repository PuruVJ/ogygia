/**
 * Internal wrappers the compile-time transform emits into host/island modules.
 *
 * **Not a public API** — do not import from app code. Prefer authoring regions with
 * `with { hydrate | defer | preset }` and the public exports from `ogygia`.
 *
 * ServerIsland lives in `ogygia/internal/server` so client graphs never see `$app/server`.
 *
 * @packageDocumentation
 * @internal
 */
export { default as Island } from './Island.svelte';
export { default as LakeBoundary } from './LakeBoundary.svelte';
export { default as LakeRegion } from './LakeRegion.svelte';
export { isNested, setNested } from './context.js';
