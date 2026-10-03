// Test stub for `virtual:ogygia/island-deps` (real one is minted by the Vite plugin): the three
// per-entry lookups Region.svelte reads while it emits its island graph and CSS — empty in unit tests.
// `islandDeps(entry)` — the build's per-entry chunk closure. A test sets it with `set_island_deps(...)`.
let island_deps: Record<string, string[]> = {};
export const islandDeps = (entry: string): string[] => island_deps[entry] ?? [];
export function set_island_deps(map: Record<string, string[]>) {
	island_deps = map;
}
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
export const islandPageWhy = (
	_entry: string
): { file: string; line: number | null; why: string }[] | null => null;
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
// `chunkContents(href)` — the readable source list of a hashed client chunk; null when unknown.
// A test sets the map with `set_chunk_contents(...)`.
let chunk_contents: Record<string, string[]> = {};
export const chunkContents = (href: string): string[] | null => chunk_contents[href] ?? null;
export function set_chunk_contents(map: Record<string, string[]>) {
	chunk_contents = map;
}
// `entryLocation(identity)` — the content-hashed file an entry is served from; null when unknown.
// A test sets the map with `set_entry_locations(...)`.
let entry_locations: Record<string, string> = {};
export const entryLocation = (identity: string): string | null => entry_locations[identity] ?? null;
export function set_entry_locations(map: Record<string, string>) {
	entry_locations = map;
}
// `chunkHeavy(href)` — a chunk's rendered total and heaviest named modules; null when unknown.
let chunk_heavy: Record<string, { total: number; top: { name: string; bytes: number }[] }> = {};
export const chunkHeavy = (href: string): { total: number; top: { name: string; bytes: number }[] } | null => chunk_heavy[href] ?? null;
export function set_chunk_heavy(map: typeof chunk_heavy) {
	chunk_heavy = map;
}
// `chunkBarrels(href)` — the re-export barrels a chunk still holds; null when unknown.
let chunk_barrels: Record<string, { name: string; fanout: number }[]> = {};
export const chunkBarrels = (href: string): { name: string; fanout: number }[] | null => chunk_barrels[href] ?? null;
export function set_chunk_barrels(map: typeof chunk_barrels) {
	chunk_barrels = map;
}
// `islandHazards(entry)` — an island's lines that draw differently in the browser; null when unknown.
type StubHazard = { file: string; line: number; code: string; kind: 'await' | 'browser'; reads?: string };
let island_hazards: Record<string, StubHazard[]> = {};
export const islandHazards = (entry: string): StubHazard[] | null => island_hazards[entry] ?? null;
export function set_island_hazards(map: typeof island_hazards) {
	island_hazards = map;
}
