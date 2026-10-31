// Ambient declarations for what this package reads from ogygia's build: the virtual modules the
// ogygia Vite plugin serves, its compile-time constants, and the dev-only window maps. Shapes kept in
// sync with packages/core/src/types.d.ts (core's build copy). Not shipped (tsdown skips `.d.ts`).

declare module 'virtual:ogygia/devtools-meta' {
	/** island id → component name (a build; empty on the dev server) */
	export const names: Record<string, string>;
}
declare module 'virtual:ogygia/island-deps' {
	/** WHAT IS INSIDE a hashed client chunk (an `islandDeps()` href): a short readable list of its
	 *  source modules — app files first, then packages; `null` when the handoff has none (dev). */
	export function chunkContents(href: string): string[] | null;
	/** a chunk's heaviest named modules with their rendered bytes (profiler builds only) */
	export function chunkHeavy(
		href: string
	): { total: number; top: { name: string; bytes: number }[] } | null;
	/** the modules the build shipped as two copies (one package file by two paths), each copy's chunk
	 *  and its bytes (profiler builds only; null when none) */
	export function chunkDuplicates():
		| { name: string; copies: { file: string; bytes: number; from?: string }[] }[]
		| null;
	/** the re-export barrels a chunk still holds, with how many modules each brings (profiler builds only) */
	export function chunkBarrels(href: string): { name: string; fanout: number }[] | null;
	/** an island entry's components' lines that draw differently in the browser (the build's scan) */
	export function islandHazards(
		entry: string
	):
		| { file: string; line: number; code: string; kind: 'await' | 'browser'; reads?: string }[]
		| null;
	/** SEED SHAPING: the top-level `page.data` keys this island entry's client code reads; `null` =
	 *  ship all (dev, an entry the handoff does not know, reads that could not be pinned). */
	export function islandPageKeys(entry: string): string[] | null;
	/** why an island ships all of page.data: the modules whose reads the build could not pin */
	export function islandPageWhy(
		entry: string
	): { file: string; line: number | null; why: string }[] | null;
}
declare module 'virtual:ogygia/profiler-maps' {
	/** The server build's module map and chunk sourcemaps as one JSON string (filled after the build),
	 *  or null outside a profiler-on server build. Loaded lazily by the profiler only. */
	const maps: string | null;
	export default maps;
}

/** DEVTOOLS event layer gate (Vite `define`; default OFF — see `ogygia({ devtools })`). */
declare const __OGYGIA_DEVTOOLS__: boolean;
/** a build with devtools on: launcher only; the dock and the page measuring start once opened */
declare const __OGYGIA_DEVTOOLS_LAZY__: boolean;
/** the profiler's browser half ships (the profiler or devtools is configured) */
declare const __OGYGIA_BEACON__: boolean;

interface Window {
	// Dev-only devtools maps the dock fetches from the plugin's `/__ogygia_devtools_meta` middleware.
	// `names`: island id → component name (tab labels). `bytes`: island id → transitive dev-module
	// size (the Bytes tab's real-cost estimate). Absent off a devtools build.
	__ogygia_region_names?: Record<string, string>;
	__ogygia_region_bytes?: Record<
		string,
		{
			bytes: number;
			modules: number;
			top?: { file: string; bytes: number }[];
			barrels?: { file: string; fanout: number }[];
		}
	>;
}
