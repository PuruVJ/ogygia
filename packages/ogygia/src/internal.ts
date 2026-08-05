// Internal: private wrappers the compile-time transform emits for *client* regions.
// NOT part of the public API — do not import directly.
// ServerIsland lives in `ogygia/internal/server` so client graphs never see `$app/server`.
export { default as Island } from './Island.svelte';
export { default as LakeBoundary } from './LakeBoundary.svelte';
