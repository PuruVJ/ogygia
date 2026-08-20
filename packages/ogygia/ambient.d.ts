// Ambient types for ogygia's build-time virtual modules. The library ships `.svelte`/`.ts` source
// (Region, OgygiaRouter, …) that import these; the ogygia vite plugin provides them at build time,
// but a consumer's `svelte-check`/`tsc` needs the declarations to type-check the imports. Keep in sync
// with packages/ogygia/src/types.d.ts (the library's own build copy).
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
}
declare module 'virtual:ogygia/manifest' {
	export const dev: boolean;
	export const regions: Record<
		string,
		{ kind: 'hydrate' | 'defer' | 'lake'; load?: () => Promise<{ default: unknown }> }
	>;
}
declare module 'virtual:ogygia/server-manifest' {
	export const islands: Record<string, () => Promise<{ default: unknown }>>;
	/** Server-island id → its built client-chunk URL (the key `islandCss()` is keyed by). */
	export const island_url: Record<string, string>;
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
	export const secret: string;
	export const secretStable: boolean;
}
declare module 'virtual:ogygia/sign' {
	export function sign(secret: string, message: string): string;
	export function verify(secret: string, message: string, sig: string): boolean;
	export function region_mac_message(
		id: string,
		exp: number | string,
		props: string,
		session?: string,
		ttl?: number | string
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
	readonly og: {
		/**
		 * Content LOADERS — each call becomes a `Source` for `content({ loader })`. The macro owns
		 * the `import.meta.glob(…, { eager: false })` plumbing: pass a LITERAL glob (or, for `git`,
		 * a repo spec) and nothing else. Anything DYNAMIC (a CMS, a database) is a hand-written
		 * `Source` instead — these four cover the static/compile-time cases. Server-only.
		 */
		readonly loader: {
			/** A markdown/`.svx` collection from a LITERAL glob (e.g. `'./docs/**​/*.svx'`).
			 *  `meta.headings` comes for free. */
			markdown(
				glob: string,
				opts?: { id?: (key: string) => string }
			): import('ogygia/content').Source<import('ogygia/content').MarkdownMeta>;
			/** A filesystem-CONVENTION collection from a LITERAL glob (e.g.
			 *  `'../content/**​/{+doc.svx,+meta.json}'`) — `NN-` ordering, `+meta.json` labels. */
			folder<Meta = Record<string, never>>(
				glob: string,
				opts?: import('ogygia/content').FolderOptions<Meta>
			): import('ogygia/content').Source<Meta>;
			/** A JSON-data collection from a LITERAL glob (e.g. `'./authors/*.json'`). */
			json(glob: string, opts?: { id?: (key: string) => string }): import('ogygia/content').Source;
			/**
			 * Source a collection straight from another git repository — no committed copy, no sync
			 * script. `spec` is a LITERAL `owner/repo[@ref][:path]`; `opts` forwards to `folder`.
			 * The plugin materializes a shallow checkout at build (cached in `node_modules/.ogygia`).
			 */
			git<Meta = Record<string, never>>(
				spec: string,
				opts?: import('ogygia/content').FolderOptions<Meta>
			): import('ogygia/content').Source<Meta>;
		};
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
			codec: import('ogygia').TransportCodec<T, D>
		): import('ogygia').TransportCodec<T, D>;
		/**
		 * A block REGISTRY from a LITERAL glob (e.g. `'./blocks/*.svelte'`). At build the macro globs
		 * the pattern (relative to this module) and emits one `with { region: 'raw' }` import per
		 * match, returning a `{ <Basename>: Component }` map keyed by each file's basename (the CMS
		 * `type` name). Every block is a raw held region, so its own nested islands wake. A block that
		 * needs a wake schedule stays a manual import spread over the top. Server-only (drives SSR).
		 */
		regions(glob: string): import('ogygia/content').BlockRegistry;
		/**
		 * A highlighted code SNIPPET, rendered at BUILD through the app's own Shiki fence pipeline and
		 * inlined as a static region (no client JS). `source` is a STATIC string or template literal
		 * (a `${…}` interpolation is a build error); `lang` is the language; `meta` is the raw fence
		 * infostring, so `'twoslash {2-4} file=app.ts'` behaves exactly as in a markdown fence. The
		 * macro dedents `source` and returns a region — render it with `<Region of={…} />`.
		 */
		code(source: string, lang: string, meta?: string): import('ogygia').RegionValue;
		/**
		 * A Markdown STRING rendered at BUILD through the app's own markdown pipeline (same remark/rehype
		 * plugins, same Shiki fences) and inlined as a static region — so `md('…')` and a `.md` document
		 * render identically. `text` is a STATIC string or template literal (no `${…}` interpolation).
		 * For static prose + fenced code only (dynamic content is a build error); render with
		 * `<Region of={…} />`.
		 */
		md(text: string): import('ogygia').RegionValue;
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
		 * Mark an imported component as a PLACED ISLAND — the macro alternative to
		 * `import X from '…' with { wake }`. Where the import-attribute form is default-import-only
		 * (one `.svelte` file per import), `asRegion` marks ANY imported component, including a NAMED
		 * export from a barrel (`import { Header } from '@design/system'`). `component` must be a bare
		 * identifier bound to a top-level import; `timing` is the wake schedule — a string
		 * (`'load' | 'idle' | 'visible' | 'interaction' | a media query`, default `'load'`) or an
		 * options object. Returns a component with the SAME props, rendered as an island:
		 * `const Header = import.meta.og.asRegion(HeaderImpl, 'load')`. Compile construct — the plugin
		 * rewrites it to a hoisted binding import; there is no runtime `asRegion`.
		 */
		asRegion<C>(
			component: C,
			timing?:
				| 'load'
				| 'idle'
				| 'visible'
				| 'interaction'
				| (string & {})
				| {
						wake?: 'load' | 'idle' | 'visible' | 'interaction' | (string & {});
						margin?: string;
						keep?: string;
				  }
		): C;
	};
}
