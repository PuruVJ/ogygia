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

/** One dependency package's declared compile surface (`"ogygia": { "files": […] }` in ITS
 *  package.json) — produced by the plugin's discovery (`vite/package-files.ts`), consumed here
 *  type-only: the compiler stays browser-host-clean, so the node:fs/glob work lives plugin-side.
 *  All paths are posix REALPATHS — Vite resolves ids through symlinks (pnpm), so gate matching
 *  must speak real paths or every check silently misses. */
export interface PackageScan {
	/** The package's published name — the stable identity prefix for its regions. */
	name: string;
	/** realpath of the package root. */
	root: string;
	/** Declared bare directories (prefix-matched, so files added mid-dev still count). */
	dirs: string[];
	/** Individually declared / glob-expanded files. */
	files: string[];
}

/** Windows separators → posix, for id matching against the (posix) declared-path index. */
const BACKSLASH_SEP = /\\/;

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
	/** `ogygia({ profiler })` normalized (or `null` when off) — baked into `virtual:ogygia/profiler-config`
	 *  so `ogygia.handle()` dynamically imports + mounts the profiler with no hooks/handler wiring. The
	 *  secret is NOT baked: it reads OGYGIA_PROFILER_SECRET at runtime unless overridden here. */
	profiler_config: Record<string, unknown> | null;
	/** `ogygia({ artifacts })` normalized (or `null` when off) — baked into
	 *  `virtual:ogygia/artifacts-config`; non-null turns the handle's artifact read/write path on. */
	artifacts_config: { ttl: number } | null;
	/** Dependency packages that DECLARED their ogygia compile surface (`"ogygia": { "files": […] }`
	 *  in THEIR package.json) — prescanned + transformed like app source, node_modules gates lifted
	 *  for exactly these paths. Optional (default none): standalone/browser hosts have no
	 *  node_modules to declare from. */
	pkg_scan?: PackageScan[];
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
	readonly pkg_scan: PackageScan[];
	readonly profiler_config: Record<string, unknown> | null;
	readonly artifacts_config: { ttl: number } | null;
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
	/** Declared package files (exact) + dirs (prefix) — the transform-gate membership index. */
	readonly #pkg_files: Set<string>;
	readonly #pkg_dirs: string[];
	/** Package roots, longest first, for stable-identity mapping (root → published name). */
	readonly #pkg_roots: Array<{ root: string; name: string }>;

	constructor(init: CompileCtxInit) {
		this.root = init.root;
		this.base = init.base;
		this.app_dir = init.app_dir;
		this.libDir = init.libDir;
		this.pkg_scan = init.pkg_scan ?? [];
		this.profiler_config = init.profiler_config;
		this.artifacts_config = init.artifacts_config;
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
		this.#pkg_files = new Set(this.pkg_scan.flatMap((p) => p.files));
		this.#pkg_dirs = this.pkg_scan.flatMap((p) => p.dirs);
		this.#pkg_roots = this.pkg_scan
			.map((p) => ({ root: p.root, name: p.name }))
			.sort((a, b) => b.root.length - a.root.length);
	}

	/** True when `code` carries an ogygia `with { … }` island hint (gates node_modules `.svelte`). */
	has_island_hint(code: string): boolean {
		return this.#island_hint_re.test(code);
	}

	/** True when `id` is inside a dependency's DECLARED `ogygia.files` surface — those files are
	 *  prescanned + transformed exactly like app source (the node_modules gates lift for them). */
	in_declared_pkg(id: string): boolean {
		if (this.#pkg_files.size === 0 && this.#pkg_dirs.length === 0) return false;
		const p = id.split(BACKSLASH_SEP).join('/');
		if (this.#pkg_files.has(p)) return true;
		for (const dir of this.#pkg_dirs) if (p.startsWith(dir + '/')) return true;
		return false;
	}

	/** Install-independent region identity for a file under a declared package: `<name>/<rel>`.
	 *  Store paths carry version + peer-resolution hashes (`node_modules/.pnpm/pkg@1.2.3(...)`),
	 *  so a root-relative identity would change per install/machine and prod HTML would stop
	 *  matching its chunks. Returns `null` for anything not under a declared package root. */
	pkg_identity(abs: string): string | null {
		if (this.#pkg_roots.length === 0) return null;
		const p = abs.split(BACKSLASH_SEP).join('/');
		for (const { root, name } of this.#pkg_roots) {
			if (p.startsWith(root + '/')) return name + p.slice(root.length);
		}
		return null;
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
