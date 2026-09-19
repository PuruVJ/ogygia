// Test stub for `virtual:ogygia/island-deps` (real one is minted by the Vite plugin): the three
// per-entry lookups Region.svelte reads while it emits preload/CSS hints — empty in unit tests.
export const islandDeps = (_entry: string): string[] => [];
// `islandCss(entry)` — the build's per-entry CSS hrefs. A test sets them with `set_island_css(...)`.
let island_css: Record<string, string[]> = {};
export const islandCss = (entry: string): string[] => island_css[entry] ?? [];
export function set_island_css(map: Record<string, string[]>) {
	island_css = map;
}
export const contentCss = (_id: string): string[] => [];
// `islandCssInline(href)` — the text of a region CSS asset the build kept under Kit's
// `inlineStyleThreshold` (null = link it). A test sets the map with `set_inline_css(...)`.
let inline_css: Record<string, string> = {};
export const islandCssInline = (href: string): string | null =>
	typeof inline_css[href] === 'string' ? inline_css[href] : null;
export function set_inline_css(map: Record<string, string>) {
	inline_css = map;
}
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
// `islandPageKeys(entry)` — the build's per-entry `page.data` keys the island reads (fail-open
// null = ship all). A test sets it with `set_page_keys(...)`.
let page_keys: string[] | null = null;
export const islandPageKeys = (_entry: string): string[] | null => page_keys;
export function set_page_keys(v: string[] | null) {
	page_keys = v;
}
// `islandRemotes(entry)` — the build's per-entry list of callable remote id-hashes (fail-open
// null). A test sets it with `set_island_remotes(...)` to check what Region records per region.
let island_remotes: string[] | null = null;
export const islandRemotes = (_entry: string): string[] | null => island_remotes;
export function set_island_remotes(v: string[] | null) {
	island_remotes = v;
}
// `islandInteractivity(entry)` — the build's per-entry component facts (handlers, $state…) for the
// profiler's wake advisor; null when the handoff has none.
export const islandInteractivity = (
	_entry: string
): { handlers: number; state: number; effects: number; binds: number; actions: number; files: number } | null =>
	null;
