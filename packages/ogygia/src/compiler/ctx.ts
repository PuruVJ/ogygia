/**
 * `CompileCtx` — the resolved compile context: the config the transform phase reads, plus its
 * derived naming accessors. A plain data holder constructed once the bundler has resolved the build
 * (root / dev / …) and the options are normalized (importKeys / presets / …). It is the config half
 * of the driver's session; the `Compiler` carries it into `transform()` so that phase never reaches
 * back into the Vite adapter — which is what keeps the driver bundler-agnostic (a future REPL feeds
 * a `CompileCtx` + source and gets the same lowering, no Vite in sight).
 */
import { fs } from './host.js';
import { islandVirtualId } from './ids.js';
import {
	islandChunkFileName,
	islandPublicUrl,
	wrapperVirtualId,
	type ImportKeys
} from './region/transform.js';

export interface CompileCtxInit {
	root: string;
	base: string;
	/** SvelteKit `config.kit.appDir` (default `_app`) — the dir Kit emits AND serves its immutable
	 *  assets under. ogygia's runtime + island chunks MUST land here too: a custom appDir otherwise
	 *  404s them (Kit's adapter only maps `<appDir>/immutable/*` to the immutable-cache route). Read
	 *  from Kit's `__SVELTEKIT_APP_DIR__` build define; `_app` when Kit isn't present (standalone).
	 *  NOTE: only the app-internal PATH lives here. `base` / `paths.assets` (CDN) resolution is Kit's
	 *  `asset()`'s job — `Region.svelte` runs every baked entry / runtime URL through it at SSR — so
	 *  ogygia never bakes a base into these URLs (doing so double-applies it). */
	app_dir: string;
	libDir: string;
	/** Extra dirs (beyond `<root>/src`) the prescan walks for island components — the shipped profiler
	 *  UI, whose server-only components would otherwise never get client hydrate chunks. */
	extra_scan_roots: string[];
	/** Extra `ogygia/router` modules NOT in app source (the shipped profiler router) — seeded into the
	 *  router-css closure so its page components' scoped `<style>` blocks emit + link like any router
	 *  page's. Only their DIRECT `.svelte` imports are taken (no barrel walk). Empty for normal apps. */
	extra_router_modules: string[];
	/** `ogygia({ profiler })` normalized (or `null` when off) — baked into `virtual:ogygia/profiler-config`
	 *  so `ogygia.handle()` dynamically imports + mounts the profiler with no hooks/handler wiring. The
	 *  secret is NOT baked: it reads OGYGIA_PROFILER_SECRET at runtime unless overridden here. */
	profiler_config: Record<string, unknown> | null;
	is_dev: boolean;
	id_salt: string;
	visibleMargin: string | undefined;
	presets: Record<string, unknown>;
	import_keys: ImportKeys;
	/** Resolved Vite aliases (used by the `bake` macro to bundle the imports a baked fn touches). */
	resolve_alias: unknown[];
	/** The app's markdown config (used by the `code`/`md` macros), or `null` when content is off. */
	markdown_config: unknown;
	/** ogygia's own package root — the `auto_brand` macro skips ogygia source (it can't self-register). */
	pkg_root: string;

	// ── virtual-module emit config (read by `Compiler.emit`) ───────────────────────────────────────
	/** Per-build HMAC material baked into the SSR-only `virtual:ogygia/secret`. */
	build_secret: string;
	/** Region-endpoint rate limit (SSR-only), `{ max: 0 }` when disabled. */
	rate_limit: { max: number; windowMs: number };
	/** Cookie name sealed into the region MAC, or '' when unbound. */
	session_cookie: string;
	/** Capability-URL TTL in seconds. */
	region_ttl: number;
	/** Router on (app-wide). `false` tree-shakes the feature out. */
	router_enabled: boolean;
	/** View Transitions on for SPA navs. */
	router_view_transitions: boolean;
	/** Package-internal absolute paths the emit inlines into generated virtual sources. */
	runtime_dir: string;
	runtime_hash: string;
	hmac_module: string;
	region_endpoint_module: string;
	client_binding_stub_file: string;
	/** `$app/*` → on-disk client-shim path map (island modules under csr=false). */
	app_shims: Record<string, string>;
	/** `command === 'build'` — gates the transform-time deterministic island-chunk emit. */
	is_build: boolean;
	/** Configured content presets (name → merged config), or `null` when content is off. */
	content_presets: Record<string, unknown> | null;
	/** Devtools instruments compiled in (`ogygia({ devtools: true })`). Bakes the standalone dock
	 *  boot for csr=true pages into `virtual:ogygia/devtools-boot-url`. */
	devtools: boolean;
}

export class CompileCtx {
	readonly root: string;
	readonly base: string;
	readonly app_dir: string;
	readonly libDir: string;
	readonly extra_scan_roots: string[];
	readonly extra_router_modules: string[];
	readonly profiler_config: Record<string, unknown> | null;
	readonly is_dev: boolean;
	readonly id_salt: string;
	readonly visibleMargin: string | undefined;
	readonly presets: Record<string, unknown>;
	readonly import_keys: ImportKeys;
	readonly resolve_alias: unknown[];
	readonly markdown_config: unknown;
	readonly pkg_root: string;
	readonly build_secret: string;
	readonly rate_limit: { max: number; windowMs: number };
	readonly session_cookie: string;
	readonly region_ttl: number;
	readonly router_enabled: boolean;
	readonly router_view_transitions: boolean;
	readonly runtime_dir: string;
	readonly runtime_hash: string;
	readonly hmac_module: string;
	readonly region_endpoint_module: string;
	readonly client_binding_stub_file: string;
	readonly app_shims: Record<string, string>;
	readonly is_build: boolean;
	readonly content_presets: Record<string, unknown> | null;
	readonly devtools: boolean;
	/** `with { … }` hint matcher — a node_modules `.svelte` is only transformed when it carries one
	 *  (so a library can declare its own islands). Built once from the resolved import keys. */
	readonly #island_hint_re: RegExp;

	constructor(init: CompileCtxInit) {
		this.root = init.root;
		this.base = init.base;
		this.app_dir = init.app_dir;
		this.libDir = init.libDir;
		this.extra_scan_roots = init.extra_scan_roots;
		this.extra_router_modules = init.extra_router_modules;
		this.profiler_config = init.profiler_config;
		this.is_dev = init.is_dev;
		this.id_salt = init.id_salt;
		this.visibleMargin = init.visibleMargin;
		this.presets = init.presets;
		this.import_keys = init.import_keys;
		this.resolve_alias = init.resolve_alias;
		this.markdown_config = init.markdown_config;
		this.pkg_root = init.pkg_root;
		this.build_secret = init.build_secret;
		this.rate_limit = init.rate_limit;
		this.session_cookie = init.session_cookie;
		this.region_ttl = init.region_ttl;
		this.router_enabled = init.router_enabled;
		this.router_view_transitions = init.router_view_transitions;
		this.runtime_dir = init.runtime_dir;
		this.runtime_hash = init.runtime_hash;
		this.hmac_module = init.hmac_module;
		this.region_endpoint_module = init.region_endpoint_module;
		this.client_binding_stub_file = init.client_binding_stub_file;
		this.app_shims = init.app_shims;
		this.is_build = init.is_build;
		this.content_presets = init.content_presets;
		this.devtools = init.devtools;
		const hint_keys = Object.values(init.import_keys).filter(
			(v) => typeof v === 'string'
		) as string[];
		this.#island_hint_re = hint_keys.length
			? new RegExp(`\\bwith\\s*\\{[^}]*\\b(?:${hint_keys.join('|')})\\b`)
			: /$^/;
	}

	/** True when `code` carries an ogygia `with { … }` island hint (gates node_modules `.svelte`). */
	has_island_hint(code: string): boolean {
		return this.#island_hint_re.test(code);
	}

	/** The feature-selected runtime chunk name (`RUNTIME_HASH` ⊕ the prescan's feature hash). Immutable-
	 *  cached, so it must bust when either ogygia's source OR the app's feature set changes. Empty feature
	 *  hash until prescan runs. `program_feature_hash` is `Program.runtime_feature_hash`, threaded in by
	 *  the caller so this stays a pure naming function. */
	runtime_chunk_filename(program_feature_hash: string): string {
		return `${this.app_dir}/immutable/og-runtime.${this.runtime_hash}${program_feature_hash ? '-' + program_feature_hash : ''}.js`;
	}

	/** App-internal URL of the runtime chunk (leading slash + appDir; NO base). SSR bakes it as the
	 *  `<script src>`, then `asset()` prepends base / the assets CDN at render time. */
	runtime_chunk_url(program_feature_hash: string): string {
		return '/' + this.runtime_chunk_filename(program_feature_hash);
	}

	/** Output filename for a hydrate island chunk (under the app dir; an on-disk build path). */
	island_chunk_filename(iid: string): string {
		return islandChunkFileName(iid, this.app_dir);
	}

	/** App-internal URL of a hydrate island chunk (leading slash + appDir; NO base — `asset()` adds it). */
	island_public_url(iid: string): string {
		return islandPublicUrl(iid, this.app_dir);
	}

	/** Read a file as UTF-8, or `null` if it can't be read (the transform tolerates missing deps). */
	read_file(abs: string): string | null {
		try {
			return fs.readFileSync(abs, 'utf-8');
		} catch {
			return null;
		}
	}

	/** Virtual island ENTRY module id for an island id. */
	island_virtual_id(iid: string): string {
		return islandVirtualId(iid);
	}

	/** Virtual wrapper `.svelte` module id for an island id. */
	wrapper_virtual_id(iid: string): string {
		return wrapperVirtualId(iid);
	}

	/** Dev URL for a dynamic `import(entry)` of a virtual island module. Base-LESS, exactly like the
	 *  prod island/runtime URLs and the dev runtime URL: `Region.svelte` runs it through Kit's `asset()`
	 *  at SSR, which is the sole base authority. Baking `base` here would double it (Vite dev serves
	 *  `/@id/…` UNDER base, and `asset()` already adds that prefix). */
	dev_url_for(virtualPath: string): string {
		return '/@id/' + virtualPath;
	}
}
