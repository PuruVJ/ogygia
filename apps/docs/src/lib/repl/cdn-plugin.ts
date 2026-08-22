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

	async function fetch_text(url: string): Promise<string | null> {
		if (text_cache.has(url)) return text_cache.get(url)!;
		const pending = inflight.get(url);
		if (pending) return pending;
		const job = (async () => {
			const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
			const fetch_p = (async () => {
				try {
					const res = await fetchFn(url, ctrl ? { signal: ctrl.signal } : undefined);
					return res.ok ? await res.text() : null;
				} catch {
					return null;
				}
			})();
			// RACE the fetch against a wall-clock timeout: robust even if the underlying fetch ignores the
			// abort signal (a slow server, a non-conforming mock) — the timeout always wins.
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout_p = new Promise<null>((res) => {
				timer = setTimeout(() => {
					ctrl?.abort();
					res(null);
				}, timeout_ms);
			});
			const txt = await Promise.race([fetch_p, timeout_p]);
			clearTimeout(timer);
			text_cache.set(url, txt);
			inflight.delete(url);
			return txt;
		})();
		inflight.set(url, job);
		return job;
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
			// already an absolute CDN/URL (a transitive dep jsdelivr wrote) → keep, load() fetches it.
			if (HTTP_URL.test(id)) return id;
			// a relative import FROM a CDN module → resolve against the importer URL, try extensions.
			if (RELATIVE.test(id) && importer && HTTP_URL.test(importer)) {
				const abs = new URL(id, importer).href;
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
				return (async () => {
					const txt = await fetch_text(id);
					if (txt == null) throw new Error('[observatory] CDN fetch failed: ' + id);
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
