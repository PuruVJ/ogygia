// Ambient types for ogygia's build-time virtual modules. The library ships `.svelte`/`.ts` source
// (Region, OgygiaRouter, …) that import these; the ogygia vite plugin provides them at build time,
// but a consumer's `svelte-check`/`tsc` needs the declarations to type-check the imports. Keep in sync
// with packages/core/src/types.d.ts (the library's own build copy). Apps reach this file through
// `ogygia/types` (the `ogygia` package's ambient.d.ts references it).
declare module 'virtual:ogygia/runtime-url' {
	const url: string;
	export default url;
}
declare module 'virtual:ogygia/runtime-entry' {
	export const __features: string[];
}
declare module 'virtual:ogygia/dev-hmr' {
	/* side-effect only — CSS HMR bridge under csr=false */
}
declare module 'virtual:ogygia/dev-hmr-url' {
	const url: string;
	export default url;
}
declare module 'virtual:ogygia/island-deps' {
	export function islandDeps(entry: string): string[];
	/** Public URLs of the CSS assets an island entry (+ its dep chunks) owns — carried with a
	 *  region response so a server-picked component styles a page that never imported it. */
	export function islandCss(entry: string): string[];
	/** og.$ hoisted factories (tag → self-contained source) for the page-inline registration
	 *  script — prod SSR only; null in dev/client (dev uses the fn-manifest virtual). */
	export function fnManifest(): Record<string, string> | null;
	/** An entry's identity (its stable URL) → the content-hashed file it is served from; `null`: none known. */
	export function entryLocation(identity: string): string | null;
}
declare module 'virtual:ogygia/manifest' {
	export const dev: boolean;
	export const regions: Record<
		string,
		{ kind: 'hydrate' | 'defer' | 'lake'; load?: () => Promise<{ default: unknown }> }
	>;
}
declare module 'virtual:ogygia/server-manifest' {
	/** The server islands' loaders, one dynamic import away. */
	export function load_islands(): Promise<typeof import('virtual:ogygia/server-islands')>;
	/** Server-island id → its built client-chunk URL (the key `islandCss()` is keyed by). */
	export const island_url: Record<string, string>;
	/** Server-island id → its component name (`SlowHole`), where the component file is known. */
	export const island_name: Record<string, string>;
	export const island_render: Record<string, string>;
	export const render_island: Record<string, string>;
}
declare module 'virtual:ogygia/server-islands' {
	export const islands: Record<string, () => Promise<{ default: unknown }>>;
}
declare module 'virtual:ogygia/region-endpoint' {
	export function makeRegionEndpoint(entry: string, props?: Record<string, unknown>): string;
	export function mintServerIsland(
		entry: string,
		props: Record<string, unknown>,
		ttl?: number
	): string;
}
declare module 'virtual:ogygia/secret' {
	export const buildKey: string;
	export const buildHadSecret: boolean;
}
declare module 'virtual:ogygia/sign' {
	export function sign(secret: string, message: string): string;
	export function verify(secret: string, message: string, sig: string): boolean;
	export function region_mac_message(
		id: string,
		exp: number | string,
		props: string,
		session?: string,
		ttl?: number | string,
		render?: string
	): string;
}
declare module 'virtual:ogygia/request-event' {
	export function getRequestEvent(): {
		cookies: { get: (name: string) => string | undefined };
		[key: string]: unknown;
	};
}
declare module 'virtual:ogygia/rate-limit' {
	export const rateLimit: { max: number; windowMs: number };
}
declare module 'virtual:ogygia/router-config' {
	export const enabled: boolean;
	export const viewTransitions: boolean;
}
declare module 'virtual:ogygia/session-cookie' {
	export const sessionCookie: string;
}
declare module 'virtual:ogygia/region-ttl' {
	export const regionTtl: number;
	export const renewWindow: number;
}
declare module 'virtual:ogygia/transport' {
	export const transport: Record<
		string,
		{ encode: (v: unknown) => unknown; decode: (v: unknown) => unknown }
	>;
}
declare module 'virtual:ogygia/kit-wire' {
	export function stringify_remote_arg(value: unknown, transport: unknown): string;
	export function stringify_command_arg(value: unknown, transport: unknown): Promise<string>;
	export function create_remote_key(id: string, payload: string): string;
}

// ── the `import.meta.og` compile surface ─────────────────────────────────────────────
// ogygia's build-time constructs, under ONE short key — platform-feeling like `import.meta.glob`,
// collision-proof by ownership, one autocomplete entry for the whole family. They are not runtime
// calls: the ogygia vite plugin rewrites each at transform time; these declarations are only types.
// The rule for what belongs here: literal inputs + a build-determined result.
interface ImportMeta {
	readonly og: ImportMetaOg;
}

/**
 * The `import.meta.og.*` constructs: core's below, plus each plugin's — a plugin package's own
 * types (`/// <reference types="@ogygia/content/types" />`) merge its macros into this interface.
 */
interface ImportMetaOg {
	/**
	 * The transportable mark — `static wire = import.meta.og.wire({ encode, decode })` on a
	 * class lets its instances cross island boundaries as props. A compile construct: the
	 * plugin CONSUMES the member and mints the symbol key (`static [Symbol.for('ogygia.wire')]
	 * = codec`), so the key never exists in source. STRICT: that member shape is the only
	 * legal position — any other use is a build error. ONE contract, always explicit:
	 * `{ encode, decode }` (+ optional `id`/`merge` for session continuity — see
	 * `TransportCodec` in `ogygia`).
	 */
	wire<T = unknown, D = unknown>(
		codec: import('@ogygia/core').TransportCodec<T, D>
	): import('@ogygia/core').TransportCodec<T, D>;
	/**
	 * Run `fn` at BUILD, serialize its result, and inline it as a constant — "run at build, ship
	 * the answer." `fn` may use this module's IMPORTS and literals and `await` freely, but must be
	 * self-contained (no closing over the module's other locals). Its result must be
	 * devalue-serializable (JSON + Date/Map/Set/RegExp/BigInt) — a function, Promise, or class
	 * instance in the result is a build error. At runtime there is no function and no work, even in
	 * client code.
	 */
	bake<T>(fn: () => T | Promise<T>): T;
	/**
	 * Brand a value as TRANSPORTABLE so it crosses an island boundary LIVE — most often a closure
	 * (the wire's fn kind: the plugin hoists it to a self-contained factory, its captured locals
	 * becoming bound params), but also a store or an `og.wire` class instance the drop-in
	 * `setContext`/`og_derived` should carry live rather than freeze. Returns the SAME value (and
	 * type) — at the call site it reads as identity; the transform does the branding/hoisting. A
	 * branded closure must be self-contained (only its own captured locals + module imports, no
	 * `$app/*`).
	 */
	$<T>(value: T): T;
	/**
	 * Mark an imported component as a region — the macro alternative to `import X from '…' with
	 * { … }`, and the escape hatch for BARRELS. The import-attribute form only reaches a DEFAULT
	 * import of one file; `asRegion` marks ANY imported component, including a NAMED export from a
	 * barrel (`import { Header } from '@design/system'`). It is a transparent escape hatch: the
	 * `options` accept EXACTLY what an import attribute accepts — no more, no less — and the output
	 * is identical, only importing the component by its export name. Every mode works: a placed
	 * island (`wake`), a deferred/live server hole (`render`), a lake (`wake: 'none'`), a held
	 * region (`region: 'raw'`), or a named `preset`.
	 *
	 * `component` must be a bare identifier bound to a top-level import, and the call must be a
	 * TOP-LEVEL `const Name = import.meta.og.asRegion(Comp, …)` in the instance `<script>`. Returns
	 * a component with the SAME props. Compile construct — rewritten to a hoisted binding import;
	 * there is no runtime `asRegion`.
	 */
	asRegion<C>(
		component: C,
		options: {
			/** hydrate schedule (placed island / lake at `'none'`); the fetch schedule for `render`. */
			wake?: 'load' | 'idle' | 'visible' | 'interaction' | 'none' | (string & {});
			/** delivery mode: a static island (default), or a `'deferred'` / `'live'` server hole. */
			render?: 'static' | 'deferred' | 'live';
			/** a held region handed to `region()` — must be the ONLY option (`'raw'`). */
			region?: 'raw';
			/** a named preset from `ogygia({ presets })` — must be the ONLY option. */
			preset?: string;
			/** keep the live island (DOM + state) across SPA navigations. */
			keep?: string;
		}
	): C;
	/**
	 * Declare a data source: `export const loadContent = import.meta.og.source(async (…) => …)`.
	 * Each call during a server render files a receipt (the source's `file#export` id plus a
	 * fingerprint of its arguments), so an invalidation names the function and its arguments
	 * instead of URL strings. Returns the SAME function. `opts.key` canonicalizes exotic
	 * arguments yourself (the default fingerprint is structural). Legal only as a top-level
	 * `export const`; anything else is a build error.
	 */
	source<A extends unknown[], R>(
		fn: (...args: A) => R,
		opts?: { key?: (...args: A) => string }
	): (...args: A) => R;
}
