// Test stub for `virtual:ogygia/island-deps` (real one is minted by the Vite plugin): the three
// per-entry lookups Region.svelte reads while it emits preload/CSS hints — empty in unit tests.
export const islandDeps = (_entry: string): string[] => [];
export const islandCss = (_entry: string): string[] => [];
export const contentCss = (_id: string): string[] => [];
