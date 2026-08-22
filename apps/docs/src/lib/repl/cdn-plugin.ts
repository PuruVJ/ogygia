/**
 * The Observatory REPL's CDN resolver as a rolldown plugin. Resolves bare npm imports against RAW
 * jsdelivr files (NOT `/+esm`, which re-bundles shared deps like the svelte runtime and mangles
 * identity) — reading `package.json` for `exports`/`browser`/`module`/`main`, then letting rolldown do
 * CJS→ESM / JSON itself. svelte (and any configured runtime) stays EXTERNAL so the mounted app shares
 * the host's instance. Works with node `rolldown` (tests) and `@rolldown/browser` (the worker).
 */
import {
	parse_specifier,
	resolve_entry,
	extension_candidates,
	is_bare,
	BROWSER_STUB
} from './npm-resolve.ts';

const CDN = 'https://cdn.jsdelivr.net/npm/';
/** Node builtins can't run in the browser — stub them (covers most `browser: { fs: false }` intents). */
const NODE_BUILTINS = new Set([
	'fs', 'path', 'os', 'crypto', 'stream', 'util', 'events', 'http', 'https', 'net', 'tls', 'zlib',
	'child_process', 'worker_threads', 'perf_hooks', 'url', 'assert', 'buffer', 'process', 'module',
	'querystring', 'string_decoder', 'tty', 'v8', 'vm'
]);
const is_node_builtin = (id: string) => id.startsWith('node:') || NODE_BUILTINS.has(id);

/** Persistent CDN caches — pass the SAME instance across bundles so an edit doesn't re-fetch jsdelivr. */
export interface CdnCache {
	pkg: Map<string, Record<string, unknown> | null>;
	text: Map<string, string | null>;
}
/** A fresh, empty CDN cache to hold across a REPL session. */
export function makeCdnCache(): CdnCache {
	return { pkg: new Map(), text: new Map() };
}

export interface CdnPluginOptions {
	/** Injected fetch (tests pass a cached/offline one); defaults to the global. */
	fetch?: typeof fetch;
	/** Extra externals beyond svelte (e.g. `ogygia`), returning true to keep `id` external. */
	isExternal?: (id: string) => boolean;
	/** Notified of each resolved bare package (for a "deps used" readout). */
	onPackage?: (name: string, version: string, url: string) => void;
	/** Notified when a bare import can't be resolved (stubbed). */
	onMissing?: (id: string) => void;
	/** Per-request timeout (ms) so a stalled CDN response can't hang the bundle. Default 15s. */
	fetchTimeout?: number;
	/** A persistent cache reused across bundles (a REPL edits constantly — don't re-fetch each keystroke). */
	cache?: CdnCache;
}

// ── Regexes hoisted to module scope (compiled once, never per resolveId/load call). ──
/** svelte's runtime stays external — the mounted app must share the host's svelte instance. */
const SVELTE_EXTERNAL = /^svelte(\/|$)/;
const HTTP_URL = /^https?:\/\//;
const RELATIVE = /^\.\.?\//;
export const CSS_MODULE = /\.css(\?|$)/;
/** `.wasm` — browsers RUN wasm; rolldown just can't parse the binary as JS. We inline the bytes and
 *  hand back a real loader (see {@link wasm_module}), so a static wasm import actually works. */
export const WASM_MODULE = /\.wasm(\?|$)/i;
/** …with `?url` → emit a `data:` URL string (Vite's convention); anything else → the init function. */
const WASM_AS_URL = /[?&]url(&|$)/;
/** Native addons — a compiled `.node` binary genuinely can't run in a browser; stub so a package that
 *  ships one (axios→kerberos.node) degrades instead of crashing the whole build. */
const NATIVE_ASSET = /\.node(\?|$)/i;
/** Binary media/fonts that occasionally leak into a JS graph — fetched-as-text they'd be un-parseable
 *  garbage that fails the build at generate time (past load's reach); stub them up front. */
const BINARY_ASSET = /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp[34]|webm|ogg|wav|pdf|zip)(\?|$)/i;

/** A `.css` import → a JS module that injects the stylesheet (rolldown can't parse CSS as JS). Idempotent
 *  per href so a re-mount doesn't stack duplicate <style> tags. Exported for the workspace loader too. */
export function css_inject_module(css: string, href: string): string {
	return (
		`const css = ${JSON.stringify(css)};\n` +
		`const key = ${JSON.stringify('repl-css:' + href)};\n` +
		`if (typeof document !== 'undefined' && !document.querySelector('style[data-repl-css=' + JSON.stringify(key) + ']')) {\n` +
		`  const s = document.createElement('style'); s.setAttribute('data-repl-css', key); s.textContent = css; document.head.appendChild(s);\n` +
		`}\nexport default css;`
	);
}

/** Base64-encode bytes in BOTH node (tests) and a browser worker (no Buffer) — chunked so a big module
 *  doesn't blow the call stack via `String.fromCharCode(...huge)`. */
function to_base64(bytes: Uint8Array): string {
	if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
	let bin = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}

/** A `.wasm` import → a JS module that inlines the bytes (base64) and either returns a `data:` URL
 *  (`?url`, Vite) or a default `init(imports?)` that instantiates it and resolves to the `WebAssembly
 *  .Instance` (the `@rollup/plugin-wasm` convention). Decoding is written to run in node AND the browser
 *  (Buffer or atob). Exported for reuse/tests. */
export function wasm_module(base64: string, as_url: boolean): string {
	if (as_url) return `export default ${JSON.stringify('data:application/wasm;base64,' + base64)};`;
	return (
		`const b64 = ${JSON.stringify(base64)};\n` +
		`const bytes = typeof Buffer !== 'undefined'\n` +
		`  ? Buffer.from(b64, 'base64')\n` +
		`  : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));\n` +
		`export default function init(imports) {\n` +
		`  return WebAssembly.instantiate(bytes, imports || {}).then((r) => r.instance);\n` +
		`}\n`
	);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RolldownPlugin = any;

export function cdnPlugin(opts: CdnPluginOptions = {}): RolldownPlugin {
	const fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
	const timeout_ms = opts.fetchTimeout ?? 15000;
	const cache = opts.cache ?? makeCdnCache();
	const pkg_cache = cache.pkg;
	const text_cache = cache.text;
	// De-dupe concurrent in-flight requests for the same URL (a barrel touches shared files a lot).
	const inflight = new Map<string, Promise<string | null>>();

	/** Run `work` (given an abort signal) but never let it outlast the timeout — RACE against a wall-clock
	 *  timer so a stalled CDN can't hang the bundle, robust even if the fetch ignores the abort signal. */
	function with_timeout<T>(work: (signal: AbortSignal | undefined) => Promise<T | null>): Promise<T | null> {
		const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout_p = new Promise<null>((res) => {
			timer = setTimeout(() => {
				ctrl?.abort();
				res(null);
			}, timeout_ms);
		});
		return Promise.race([work(ctrl?.signal), timeout_p]).finally(() => clearTimeout(timer));
	}

	/** Cache + de-dupe a fetch keyed by `key`, running `work` once on a miss (both fetch_text/wasm share). */
	function cached_fetch(key: string, work: (signal: AbortSignal | undefined) => Promise<string | null>): Promise<string | null> {
		if (text_cache.has(key)) return Promise.resolve(text_cache.get(key)!);
		const pending = inflight.get(key);
		if (pending) return pending;
		const job = with_timeout(work).then((v) => {
			text_cache.set(key, v);
			inflight.delete(key);
			return v;
		});
		inflight.set(key, job);
		return job;
	}

	function fetch_text(url: string): Promise<string | null> {
		return cached_fetch(url, async (signal) => {
			try {
				const res = await fetchFn(url, signal ? { signal } : undefined);
				return res.ok ? await res.text() : null;
			} catch {
				return null;
			}
		});
	}
	/** Fetch a binary asset (a `.wasm`) as base64 — separate cache key so it never collides with the same
	 *  URL fetched as text. Returns null (→ inert stub) on failure/timeout. */
	function fetch_bytes_base64(url: string): Promise<string | null> {
		return cached_fetch('\0bytes:' + url, async (signal) => {
			try {
				const res = await fetchFn(url, signal ? { signal } : undefined);
				if (!res.ok) return null;
				return to_base64(new Uint8Array(await res.arrayBuffer()));
			} catch {
				return null;
			}
		});
	}
	async function fetch_pkg(name: string, version: string): Promise<Record<string, unknown> | null> {
		const key = name + '@' + (version || 'latest');
		if (pkg_cache.has(key)) return pkg_cache.get(key)!;
		const url = CDN + name + (version ? '@' + version : '') + '/package.json';
		const txt = await fetch_text(url);
		let pkg: Record<string, unknown> | null = null;
		try {
			pkg = txt ? JSON.parse(txt) : null;
		} catch {
			pkg = null;
		}
		pkg_cache.set(key, pkg);
		return pkg;
	}
	/** Fetch the first existing candidate URL for a package-relative path (extension resolution). */
	async function resolve_existing(base: string, rel: string): Promise<string | null> {
		for (const cand of extension_candidates(rel.startsWith('./') ? rel : './' + rel)) {
			const url = new URL(cand, base).href;
			if ((await fetch_text(url)) != null) return url;
		}
		return null;
	}

	return {
		name: 'observatory-cdn',
		async resolveId(id: string, importer: string | undefined) {
			// svelte runtime + configured externals: keep external (shared with the host mount).
			if (SVELTE_EXTERNAL.test(id) || opts.isExternal?.(id)) return { id, external: true };
			// node builtins → stub (browser can't run them).
			if (is_node_builtin(id)) return BROWSER_STUB + ':' + id;
			// native addons (`.node`) + binary media/fonts → inert stub (in ANY specifier form: bare
			// `pkg/x.node`, relative `./x.png`, or an absolute transitive URL). `.wasm` is NOT here — it's a
			// real loader (load() inlines the bytes). Never fetched, never crash the build.
			if (NATIVE_ASSET.test(id) || BINARY_ASSET.test(id)) {
				if (NATIVE_ASSET.test(id)) opts.onMissing?.(id);
				return BROWSER_STUB + ':' + id;
			}
			// already an absolute CDN/URL (a transitive dep jsdelivr wrote) → keep, load() fetches it.
			if (HTTP_URL.test(id)) return id;
			// a relative import FROM a CDN module → resolve against the importer URL, try extensions.
			if (RELATIVE.test(id) && importer && HTTP_URL.test(importer)) {
				const abs = new URL(id, importer).href;
				// A `.wasm` has an explicit extension — no need to probe candidates (which would fetch it as
				// text); hand the URL straight to load(), which fetches the bytes.
				if (WASM_MODULE.test(id)) return abs;
				const found = await resolve_existing(new URL('.', importer).href, id);
				return found ?? abs;
			}
			// bare npm import → package.json resolution.
			if (is_bare(id)) {
				const { name, version, subpath } = parse_specifier(id);
				const pkg = await fetch_pkg(name, version);
				if (!pkg) {
					opts.onMissing?.(id);
					return BROWSER_STUB + ':' + id; // unknown package → inert stub, keeps the build alive
				}
				const rel = resolve_entry(pkg, subpath);
				if (rel === BROWSER_STUB) return BROWSER_STUB + ':' + id;
				const ver = (pkg.version as string) || version || '';
				const base = CDN + name + (ver ? '@' + ver : '') + '/';
				const url = await resolve_existing(base, rel);
				if (!url) {
					opts.onMissing?.(id);
					return BROWSER_STUB + ':' + id;
				}
				opts.onPackage?.(name, ver, url);
				return url;
			}
			return null; // workspace/other → left to sibling plugins
		},
		load(id: string): { code: string; moduleType?: string } | Promise<{ code: string; moduleType?: string }> | null {
			if (id.startsWith(BROWSER_STUB)) {
				// An inert module — default {} so any import shape "works". moduleType:'js' so a stubbed
				// `.css`/`.node`/… id isn't mis-tagged (rolldown infers type from the id's extension).
				return { code: 'const x = {}; export default x;', moduleType: 'js' };
			}
			if (HTTP_URL.test(id)) {
				// `.wasm` → fetch the BYTES (not text) and emit a real loader (init fn, or a data: URL for
				// `?url`). Browsers run wasm; only rolldown can't parse the binary — so we inline it.
				if (WASM_MODULE.test(id)) {
					return (async () => {
						const b64 = await fetch_bytes_base64(id.split('?')[0]);
						if (b64 == null) {
							opts.onMissing?.(id);
							return { code: 'const x = {}; export default x;', moduleType: 'js' };
						}
						return { code: wasm_module(b64, WASM_AS_URL.test(id)), moduleType: 'js' };
					})();
				}
				return (async () => {
					const txt = await fetch_text(id);
					if (txt == null) {
						// A transitive file we couldn't fetch (a 404, a binary, a network blip). DON'T throw —
						// one bad file must not kill the whole preview. Degrade to an inert stub + note it.
						opts.onMissing?.(id);
						return { code: 'const x = {}; export default x;', moduleType: 'js' };
					}
					// CSS can't be bundled by rolldown — inject it via a JS module, forced to moduleType 'js'
					// (the `.css` id would otherwise be tagged CSS and rejected).
					if (CSS_MODULE.test(id)) return { code: css_inject_module(txt, id), moduleType: 'js' };
					return { code: txt };
				})();
			}
			return null;
		}
	};
}
