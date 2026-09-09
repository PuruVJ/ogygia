// Test stub for `virtual:ogygia/island-deps` (real one is minted by the Vite plugin): the three
// per-entry lookups Region.svelte reads while it emits preload/CSS hints — empty in unit tests.
export const islandDeps = (_entry: string): string[] => [];
export const islandCss = (_entry: string): string[] => [];
export const contentCss = (_id: string): string[] => [];
// `ogygia({ regions: { preload } })` — the plugin default. A LIVE binding: a test flips it with
// `set_preload_policy(...)` and Region.svelte (which imports this same aliased module) reads the
// new value on its next render.
export let preloadPolicy: 'all' | 'load' | 'none' = 'load';
export function set_preload_policy(p: 'all' | 'load' | 'none') {
	preloadPolicy = p;
}
