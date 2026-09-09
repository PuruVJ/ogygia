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
// `islandReadsPage(entry)` — the build's per-entry "reads `$page`" flag (fail-open true). A test
// flips it with `set_reads_page(...)` to check that Region records the page snapshot only for
// islands whose client code reads it.
let reads_page = true;
export const islandReadsPage = (_entry: string): boolean => reads_page;
export function set_reads_page(v: boolean) {
	reads_page = v;
}
