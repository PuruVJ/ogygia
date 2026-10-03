// Ambient declarations for the library's own build-time virtual modules and the Kit modules it
// references. These make `tsc --noEmit` clean; they are not shipped (excluded from tsdown entry).

declare module 'virtual:ogygia/manifest' {
	export const dev: boolean;
	/**
	 * Legacy empty stub. Hydrate islands load via `<ogygia-region entry>` module URLs;
	 * this map is no longer populated.
	 */
	export const regions: Record<
		string,
		{ kind: 'hydrate' | 'defer' | 'lake'; load?: () => Promise<{ default: unknown }> }
	>;
}
declare module 'virtual:ogygia/region-endpoint' {
	export function makeRegionEndpoint(entry: string, props?: Record<string, unknown>): string;
	/** @param ttl response cache max-age in seconds (`0`/absent = no-store). Signed into the URL. */
	export function mintServerIsland(
		entry: string,
		props: Record<string, unknown>,
		ttl?: number
	): string;
	/** The island `data-og-fp` over its module URL + canonical props text (server/fingerprint.ts);
	 *  `''` on the client, which only ever reads the attribute. */
	export function islandFingerprint(entry: string, canonical: string): string;
}
declare module 'virtual:ogygia/server-manifest' {
	export const islands: Record<string, () => Promise<{ default: unknown }>>;
	/** Server-island id → its built client-chunk URL (the key `islandCss()` is keyed by). */
	export const island_url: Record<string, string>;
	/** Server-island id → its component name (`SlowHole`), where the component file is known. */
	export const island_name: Record<string, string>;
}
declare module 'virtual:ogygia/runtime-url' {
	const url: string;
	export default url;
}
/** The generated runtime entry — side effects only (it boots); it exports nothing. */
declare module 'virtual:ogygia/runtime-entry' {}

declare module 'virtual:ogygia/devtools-meta' {
	/** island id → component name (a build; empty on the dev server) */
	export const names: Record<string, string>;
}
declare module 'virtual:ogygia/island-deps' {
	/** Public URLs of hashed dependency chunks for a hydrate island entry (`/_app/immutable/…`). */
	export function islandDeps(entry: string): string[];
	/** WAKE ADVISOR: what the island's own components do (handlers, `$state`, `$effect`, `bind:`,
	 *  `use:` counts over its closure), from the build; `null` when the handoff has no facts. */
	export function islandInteractivity(entry: string): {
		handlers: number;
		state: number;
		effects: number;
		binds: number;
		actions: number;
		files: number;
	} | null;
	/** WHAT IS INSIDE a hashed client chunk (an `islandDeps()` href): a short readable list of its
	 *  source modules — app files first, then packages; `null` when the handoff has none (dev). */
	export function chunkContents(href: string): string[] | null;
	/** a chunk's heaviest named modules with their rendered bytes (profiler builds only) */
	export function chunkHeavy(href: string): { total: number; top: { name: string; bytes: number }[] } | null;
	/** the modules the build shipped as two copies (one package file by two paths), each copy's chunk
	 *  and its bytes (profiler builds only; null when none) */
	export function chunkDuplicates(): { name: string; copies: { file: string; bytes: number; from?: string }[] }[] | null;
	/** the re-export barrels a chunk still holds, with how many modules each brings (profiler builds only) */
	export function chunkBarrels(href: string): { name: string; fanout: number }[] | null;
	/** an island entry's components' lines that draw differently in the browser (the build's scan) */
	export function islandHazards(entry: string): { file: string; line: number; code: string; kind: 'await' | 'browser'; reads?: string }[] | null;
	/** Public URLs of the CSS assets an island entry (+ its dep chunks) owns — carried with a
	 *  region response so a server-picked component styles a page that never imported it. */
	export function islandCss(entry: string): string[];
	/** INLINE REGION CSS: the text of a region CSS asset (an `islandCss()` / `contentCss()` href)
	 *  the build kept under Kit's `inlineStyleThreshold`, so the render emits it as a `<style>`
	 *  instead of a blocking `<link>`. `null` = link it (over the threshold, no threshold, dev). */
	export function islandCssInline(href: string): string | null;
	/** Does this island entry's client code read `$page` (the `$app/state` / `$app/stores` shim is
	 *  in its chunk closure)? Decides whether the page seed ships. Fail-open: true in dev and for an
	 *  entry the build handoff does not know. */
	export function islandReadsPage(entry: string): boolean;
	/** SEED SHAPING: the top-level `page.data` keys this island entry's client code reads (the
	 *  build's AST analysis over its chunk closure — link/page-keys.ts), so the handle ships only
	 *  those. `null` = ship all: dev, an entry the handoff does not know, or a closure whose reads
	 *  could not be pinned to literal keys. */
	export function islandPageKeys(entry: string): string[] | null;
	/** why an island ships all of page.data: the modules whose reads the build could not pin */
	export function islandPageWhy(
		entry: string
	): { file: string; line: number | null; why: string }[] | null;
	/** The Kit remote-function modules (by id-hash, the prefix of `internals.id`) an island entry's
	 *  client code can call — static + dynamic imports in its chunk closure. Decides which
	 *  SSR-resolved remotes the page seeds (`application/ogygia-remote`). Fail-open: `null` ("may
	 *  call anything") in dev and for an entry the build handoff does not know. */
	export function islandRemotes(entry: string): string[] | null;
	/** og.$ hoisted factories (tag → self-contained source) for the page-inline registration
	 *  script — prod SSR only; null in dev/client (dev uses the fn-manifest virtual). */
	export function fnManifest(): Record<string, string> | null;
	/** An entry's identity (its stable URL) → the content-hashed file it is served from; `null`: none known. */
	export function entryLocation(identity: string): string | null;
}
declare module 'virtual:ogygia/dev-hmr' {
	/* side-effect only — CSS HMR bridge under csr=false */
}
declare module 'virtual:ogygia/dev-hmr-url' {
	const url: string;
	export default url;
}
declare module 'virtual:ogygia/devtools-boot' {
	/* side-effect only — mounts the standalone devtools dock on a csr=true page */
}
declare module 'virtual:ogygia/devtools-boot-url' {
	const url: string;
	export default url;
}
declare module 'virtual:ogygia/secret' {
	export const secret: string;
	/** True when the key is env-provided (OGYGIA_SECRET) and thus survives redeploys. */
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
		request: Request;
		[key: string]: unknown;
	};
}
declare module 'virtual:ogygia/rate-limit' {
	/** `max: 0` disables. Baked from `ogygia({ rateLimit })`. */
	export const rateLimit: { max: number; windowMs: number };
}
declare module 'virtual:ogygia/profiler-config' {
	/** Profiler options from `ogygia({ profiler })`, or `null` when off. SERVER only (client: null).
	 *  `ogygia.handle()` reads this and dynamically imports + mounts the profiler when non-null. */
	export const profilerConfig: Record<string, unknown> | null;
}
declare module 'virtual:ogygia/profiler-maps' {
	/** The server build's module map and chunk sourcemaps as one JSON string (filled after the build),
	 *  or null outside a profiler-on server build. Loaded lazily by the profiler only. */
	const maps: string | null;
	export default maps;
}
declare module 'virtual:ogygia/freeze-config' {
	/** Freeze policy from `ogygia({ freeze })`, or `null` when off. SERVER only (client: null).
	 *  Non-null turns the handle's freeze (render-on-write) read/write path on. `default` is the
	 *  app-wide opt-in (true = auto by observed purity, false = per-route opt-in). */
	export const freezeConfig: { ttl: number; default: boolean } | null;
}
declare module 'virtual:ogygia/freeze-routes' {
	/** Route ids (group-stripped) whose effective `export const freeze` opt-in is true, given the
	 *  config `default` — the handle gates the store/serve path on membership. SSR leg only; the
	 *  client leg is an empty set (the route list never ships to the browser). */
	export const freeze_routes: ReadonlySet<string>;
	/** EVERY page route id (group-stripped), opted in or not — lets the handle tell "a page whose
	 *  cascaded value is false" from "not a page" (endpoint / unclaimed → config `default`). */
	export const freeze_pages: ReadonlySet<string>;
}
declare module 'virtual:ogygia/session-cookie' {
	/** Cookie name sealed into the region MAC, or '' when unbound. From `ogygia({ sessionCookie })`. */
	export const sessionCookie: string;
}
declare module 'virtual:ogygia/router-config' {
	/** SPA router on (default) or opted out via `ogygia({ router: false })`. */
	export const enabled: boolean;
	/** Use the View Transitions API on navigation. `ogygia({ router: { viewTransitions } })`. */
	export const viewTransitions: boolean;
	/** MPA mode only (`router: false`): the static Speculation Rules JSON the handle injects into
	 *  every page head (native prerender/prefetch of likely next pages). `''` when the router is on —
	 *  speculation caches serve real navigations only, which a body-swap router can never read. */
	export const speculationRules: string;
}
declare module 'virtual:ogygia/region-ttl' {
	/** Capability URL TTL in seconds. From `ogygia({ regions: { ttl } })` (default 3600). */
	export const regionTtl: number;
}
declare module 'virtual:ogygia/route-csr' {
	/** Route ids (Kit `route.id`, group-stripped) whose effective csr is true — SSR leg only; the
	 *  client leg is an empty set (it reads `kit_hydrates_page()` instead). */
	export const csr_true_routes: ReadonlySet<string>;
	/** Route ids whose ERROR render (`+error.svelte`, rendered by Kit from the layout branch alone)
	 *  is hydrated — the layouts' effective csr, the page's option ignored. SSR leg only. */
	export const error_csr_true_routes: ReadonlySet<string>;
	/** The routeless error render (no route matched → root layout + root error page): the root
	 *  layout's own csr, Kit's default `true` when unset. SSR leg only. */
	export const root_layout_csr_true: boolean;
}
/** CONTINUITY compile-time constants (Vite `define`; typeof-guarded so node dist import is safe). */
declare const __OGYGIA_CONTINUITY_FORMS__: boolean;
/** SERVER-DELTA NAV opt-in (Vite `define`; default OFF — see `router.serverDelta`). */
declare const __OGYGIA_SERVER_DELTA__: boolean;
/** DEVTOOLS event layer gate (Vite `define`; default OFF — see `ogygia({ devtools })`). When off,
 *  every `if (DEVTOOLS) emit({…})` folds to `if (false)` and the whole bus tree-shakes away. */
declare const __OGYGIA_DEVTOOLS__: boolean;
/** a build with devtools on: launcher only; the dock and the page measuring start once opened */
declare const __OGYGIA_DEVTOOLS_LAZY__: boolean;
/** the profiler's browser half ships (the profiler or devtools is configured); otherwise every
 *  `if (BEACON) …` folds out and runtime/beacon.ts leaves the bundle */
declare const __OGYGIA_BEACON__: boolean;

declare module 'virtual:ogygia/router-css' {
	// Generated component→CSS registrations for the server router — side-effect only.
}
declare module 'virtual:ogygia/kit-transport' {
	export const transport: Record<
		string,
		{ encode: (v: unknown) => unknown; decode: (v: unknown) => unknown }
	>;
}
declare module 'virtual:ogygia/transport' {
	export const transport: Record<
		string,
		{ encode: (v: unknown) => unknown; decode: (v: unknown) => unknown }
	>;
}
/** The hydrate-phase features the app's marks selected (compiler/link/runtime-entry.ts). */
declare module 'virtual:ogygia/hydrate-features' {
	export function install(): void;
}
declare module 'virtual:ogygia/transportables' {
	/** client: a transportable class module's tag path → its lazy import (server: empty, eager) */
	export const wire_loaders: Record<string, () => Promise<unknown>>;
	/** client: the app sends wired values through Kit's transport — every class loads with every island */
	export const wire_all: boolean;
}
declare module 'virtual:ogygia/kit-wire' {
	export function stringify_remote_arg(value: unknown, transport: unknown): string;
	export function stringify_command_arg(value: unknown, transport: unknown): Promise<string>;
	export function create_remote_key(id: string, payload: string): string;
}

declare module '$app/paths' {
	export const base: string;
	export const assets: string;
	export function resolve(id: string, params?: Record<string, string>): string;
	export function asset(file: string): string;
}
declare module '$app/environment' {
	export const building: boolean;
	export const browser: boolean;
	export const dev: boolean;
}
declare module '$app/server' {
	export function getRequestEvent(): {
		cookies: { get: (name: string) => string | undefined };
		request: Request;
		[key: string]: unknown;
	};
}

// Minimal ambient for the one Kit type the library imports (`Handle` in hooks.ts). The lib does
// not depend on @sveltejs/kit; the CONSUMER's real Kit types back the shipped `dist/hooks.d.ts`
// (`@sveltejs/kit` is externalised by tsdown). Not shipped (types.d.ts is excluded from tsdown).
declare module '@sveltejs/kit' {
	export interface RequestEvent {
		url: URL;
		[key: string]: unknown;
	}
	export interface ResolveOptions {
		transformPageChunk?: (input: {
			html: string;
			done: boolean;
		}) => string | undefined | Promise<string | undefined>;
	}
	export type Handle = (input: {
		event: RequestEvent;
		resolve: (event: RequestEvent, opts?: ResolveOptions) => Response | Promise<Response>;
	}) => Response | Promise<Response>;
}

// Kit's INTERNAL server request store (deep import, same posture as the vite deep-imports).
// `get_request_store()` returns the live per-request state; `state.remote` is the map Kit
// populates during a csr=false render but only serializes when csr===true (see hooks.ts). Only
// the fields the flicker-seeding path reads are declared. Not shipped (types.d.ts excluded).
declare module '@sveltejs/kit/internal/server' {
	export interface RemoteInternals {
		id: string;
		type: string;
	}
	export interface RequestRemoteState {
		implicit: Map<RemoteInternals, Record<string, () => Promise<unknown>>> | null;
		data: Map<RemoteInternals, Record<string, Promise<unknown>>> | null;
	}
	export interface RequestState {
		transport?: Record<
			string,
			{ encode: (v: unknown) => unknown; decode: (v: unknown) => unknown }
		>;
		remote: RequestRemoteState;
	}
	export interface RequestStore {
		event: unknown;
		state: RequestState;
	}
	export function get_request_store(): RequestStore;
	export function try_get_request_store(): RequestStore | null;
}

interface Window {
	// Dev-only devtools maps the dock fetches from the plugin's `/__ogygia_devtools_meta` middleware.
	// `names`: island id → component name (tab labels). `bytes`: island id → transitive dev-module
	// size (the Bytes tab's real-cost estimate). Absent off a devtools build.
	__ogygia_region_names?: Record<string, string>;
	__ogygia_region_bytes?: Record<
		string,
		{ bytes: number; modules: number; top?: { file: string; bytes: number }[]; barrels?: { file: string; fanout: number }[] }
	>;
}

// Rune globals used by the `.svelte.ts` shims. Those files are compiled by the CONSUMER's
// svelte pipeline (which understands runes); this ambient declaration only satisfies the
// library's own plain `tsc` type-check. Not shipped (types.d.ts is excluded from tsdown).
declare function $state<T>(initial: T): T;
