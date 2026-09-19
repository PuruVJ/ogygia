/**
 * Whole-program island dependency collection — from a finished client bundle, the transitive static
 * import + CSS chains for each `og-region.<id>.js` facade, so SSR can `modulepreload` a hydrate
 * island's hashed dependency chunks (Vite's auto graph does not cover `@vite-ignore` `import(entry)`).
 * Pure over the bundle it is handed. Covered by unit tests.
 */
import { path } from '../host.js';
import { merge_page_keys, type PageKeys } from './page-keys.js';

/** Deterministic island facade filename (content-hashed Vite deps are separate). */
const ISLAND_FACADE_RE = /(?:^|\/)og-region\.[0-9a-f]+\.js$/;
/** A Kit remote-function module (`*.remote.js` / `.ts`, Kit's `moduleExtensions` defaults), once
 *  its `?query` is stripped. In the CLIENT graph Kit swaps its body for fetching stubs, but the
 *  module keeps its file id — which is how an island's chunk closure names the remotes it can call. */
const REMOTE_MODULE_RE = /\.remote\.[cm]?[jt]s$/;
const BACKSLASH_G = /\\/g;

/**
 * Kit's own `hash()` (`@sveltejs/kit/src/utils/hash.js`: djb2 ×33 xor, unsigned, base36) — the
 * function a remote's id is minted with: `${hash(file)}/${exportName}`, `file` the module's path
 * relative to `process.cwd()`, posix. Mirrored here (Kit does not export it) so the build can
 * name a remote by the same id the server sees on `internals.id` at render time. Covered by a
 * vector test against ids observed from a real Kit build.
 */
export function kit_remote_hash(file: string): string {
	let hash = 5381;
	let i = file.length;
	while (i) hash = (hash * 33) ^ file.charCodeAt(--i);
	return (hash >>> 0).toString(36);
}

/**
 * The Kit remote id-hash of a CLIENT module id, or `null` for a module that is not a remote file.
 * `cwd` is what Kit hashed the file against (`process.cwd()` at build), either separator.
 *
 * @internal Exported for the plugin and unit tests.
 */
export function remote_hash_of(module_id: string, cwd: string): string | null {
	const id = module_id.split('?')[0].replace(BACKSLASH_G, '/');
	if (!REMOTE_MODULE_RE.test(id)) return null;
	const root = cwd.replace(BACKSLASH_G, '/').replace(TRAILING_SLASH_RE, '');
	const rel = id.startsWith(root + '/') ? id.slice(root.length + 1) : path.posix.relative(root, id);
	return kit_remote_hash(rel);
}
const TRAILING_SLASH_RE = /\/+$/;

/**
 * From a client `generateBundle` output, collect transitive static `imports` for each
 * `og-region.<id>.js` facade. Keys/values are public URLs (`/_app/immutable/…`).
 * Used so SSR can `modulepreload` hashed dependency chunks for `hydrate: 'load'` islands
 * (Vite’s auto graph does not apply to `@vite-ignore` `import(entry)`).
 *
 * @internal Exported for unit tests.
 */
export function collectIslandDepModulepreloads(
	bundle: Record<
		string,
		{
			type: string;
			fileName?: string;
			imports?: string[];
			dynamicImports?: string[];
			/** The source module ids bundled into this chunk (Rollup/rolldown `OutputChunk`). */
			moduleIds?: string[];
			/** Vite/rolldown-vite chunk metadata — `importedCss` lists the CSS assets a chunk owns. */
			viteMetadata?: { importedCss?: Set<string> | string[] };
		}
	>,
	/**
	 * Source files whose presence in an island's chunk closure means the island READS THE PAGE
	 * (the `$app/state` / `$app/stores` shims). Per entry, `page[entryUrl]` says whether any chunk
	 * in its closure bundles one of them — what lets the handle skip the page seed on a page whose
	 * islands never read it. Absolute paths, either separator.
	 */
	page_reader_files: readonly string[] = [],
	/**
	 * Names a bundled module's Kit remote id-hash (`remote_hash_of`), or `null` for a module that is
	 * no remote file. Per entry, `remotes[entryUrl]` lists every remote module in the island's chunk
	 * closure — static AND dynamic imports, since a remote called after an `await import()` is still
	 * this island's call — which is what lets the handle seed a remote's SSR result only when some
	 * island on the page can call it (REMOTE SEED ONLY WHEN REACHABLE). Absent → every entry `[]`.
	 */
	remote_hash: ((module_id: string) => string | null) | null = null,
	/**
	 * SEED SHAPING: the top-level `page.data` keys a bundled module reads (link/page-keys.ts, recorded
	 * by the transform), `'all'` when its reads could not be pinned, `null` for a module that never
	 * imports the page. Per entry, `page_keys[entryUrl]` is the union over its chunk closure — the
	 * keys the handle ships — or `null` (ship all) when any module said `'all'`, or when the closure
	 * reads the page through a module the transform never saw. Absent → every reader `null`.
	 */
	page_keys_of: ((module_id: string) => PageKeys | null) | null = null,
	/**
	 * WAKE ADVISOR: reads a bundled `.svelte` source by id so the collector can count what the
	 * island's components do (handlers, `$state`, `bind:`…). Per entry, `interactivity[entryUrl]`
	 * is the union over its closure's own components (dependencies and ogygia's wrappers skipped).
	 * Absent → no facts (the profiler shows none).
	 */
	read_source: ((id: string) => string | null) | null = null
): {
	js: Record<string, string[]>;
	css: Record<string, string[]>;
	page: Record<string, boolean>;
	page_keys: Record<string, string[] | null>;
	remotes: Record<string, string[]>;
	interactivity: Record<string, IslandInteractivityFacts>;
} {
	const js: Record<string, string[]> = {};
	const css: Record<string, string[]> = {};
	const page: Record<string, boolean> = {};
	const page_keys: Record<string, string[] | null> = {};
	const remotes: Record<string, string[]> = {};
	const interactivity: Record<string, IslandInteractivityFacts> = {};
	// WAKE ADVISOR FACTS: what the island's own `.svelte` sources do — handlers, `$state`,
	// `$effect`, `bind:`, `use:` — counted once per file, unioned over the closure. A regex count
	// on purpose: it needs no parse, it survives every syntax the transform accepts, and an island
	// with zero of everything is the one fact that matters (a lake wearing an island's wake).
	const facts_cache = new Map<string, IslandInteractivityFacts | null>();
	const facts_of = (id: string): IslandInteractivityFacts | null => {
		if (!read_source) return null;
		const clean = norm(id.split('?')[0]);
		if (!clean.endsWith('.svelte') || OWN_OR_DEP_RE.test(clean)) return null;
		const hit = facts_cache.get(clean);
		if (hit !== undefined) return hit;
		const src = read_source(clean);
		const f = src === null ? null : interactivity_facts(src);
		facts_cache.set(clean, f);
		return f;
	};
	const norm = (p: string) => p.split('\\').join('/');
	const readers = new Set(page_reader_files.map(norm));
	// The keys every module of a chunk reads, unioned; `undefined` = no module in it reads the page.
	const keys_in = (fileName: string): PageKeys | null | undefined => {
		if (!page_keys_of) return undefined;
		let acc: PageKeys | null = null;
		let any = false;
		for (const id of bundle[fileName]?.moduleIds ?? []) {
			const k = page_keys_of(norm(id.split('?')[0]));
			if (k === null) continue;
			any = true;
			acc = merge_page_keys(acc, k);
			if (acc === 'all') break;
		}
		return any ? acc : undefined;
	};
	const reads_page = (fileName: string): boolean => {
		if (!readers.size) return false;
		for (const id of bundle[fileName]?.moduleIds ?? []) {
			if (readers.has(norm(id.split('?')[0]))) return true;
		}
		return false;
	};
	const remotes_in = (fileName: string, acc: Set<string>): void => {
		if (!remote_hash) return;
		for (const id of bundle[fileName]?.moduleIds ?? []) {
			const h = remote_hash(id);
			if (h) acc.add(h);
		}
	};
	// Every EMITTED chunk reachable from `fileName` through static or dynamic imports (the facade
	// included) — the remotes scan's closure. Wider than the preload walk on purpose: a preload hint
	// for a dynamic chunk would be waste, a remote called from one is still this island's call.
	const closure_all = (fileName: string): Set<string> => {
		const seen = new Set<string>([fileName]);
		const queue = [fileName];
		while (queue.length) {
			const chunk = bundle[queue.pop()!];
			if (!chunk || chunk.type !== 'chunk') continue;
			for (const imp of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
				if (seen.has(imp)) continue;
				const dep = bundle[imp];
				if (!dep || dep.type !== 'chunk') continue;
				seen.add(imp);
				queue.push(imp);
			}
		}
		return seen;
	};

	const css_of = (fileName: string): string[] => {
		const chunk = bundle[fileName];
		const imported = chunk?.viteMetadata?.importedCss;
		if (!imported) return [];
		return [...imported].map((f) => (f.startsWith('/') ? f : '/' + f));
	};

	const walk = (fileName: string, seen: Set<string>, css_acc: string[]): string[] => {
		const chunk = bundle[fileName];
		if (!chunk || chunk.type !== 'chunk') return [];
		const deps: string[] = [];
		for (const imp of chunk.imports ?? []) {
			if (seen.has(imp)) continue;
			seen.add(imp);
			// Only preload chunks that are actually EMITTED. Rolldown can list a phantom import in a
			// chunk's `imports` (a shared chunk that was merged/tree-shaken away before write) — the
			// real facade never imports it. Baking a modulepreload for a non-existent chunk 404s the
			// prerender. A missing preload only costs a waterfall, so skipping phantoms is safe.
			const dep = bundle[imp];
			if (!dep || dep.type !== 'chunk') continue;
			deps.push(imp.startsWith('/') ? imp : '/' + imp);
			css_acc.push(...css_of(imp));
			deps.push(...walk(imp, seen, css_acc));
		}
		return deps;
	};

	for (const [key, chunk] of Object.entries(bundle)) {
		if (chunk.type !== 'chunk') continue;
		const fileName = chunk.fileName || key;
		if (!ISLAND_FACADE_RE.test(fileName)) continue;
		const entryUrl = fileName.startsWith('/') ? fileName : '/' + fileName;
		const seen = new Set<string>([fileName]);
		// CSS: the facade's own styles + every dep chunk's — this is how a server-picked (held)
		// component's scoped CSS reaches a page that never imported it (the page's stylesheet set
		// can't know; the region response carries these hrefs instead).
		const css_acc = css_of(fileName);
		const raw = walk(fileName, seen, css_acc);
		const uniq: string[] = [];
		const have = new Set<string>([entryUrl]);
		for (const d of raw) {
			if (have.has(d)) continue;
			have.add(d);
			uniq.push(d);
		}
		js[entryUrl] = uniq;
		css[entryUrl] = [...new Set(css_acc)];
		// The facade + every chunk in its closure: does any of them bundle a page-reading shim?
		let reads = reads_page(fileName);
		if (!reads) for (const s of seen) if (s !== fileName && reads_page(s)) reads = true;
		page[entryUrl] = reads;
		// SEED SHAPING: which `page.data` keys the closure reads. A reader whose keys no module
		// recorded (the page reached through a module the transform never saw) ships all.
		if (reads) {
			let acc: PageKeys | null = null;
			let saw_reader = false;
			for (const s of seen) {
				const k = keys_in(s);
				if (k === undefined) continue;
				saw_reader = true;
				acc = merge_page_keys(acc, k);
				if (acc === 'all') break;
			}
			page_keys[entryUrl] = !saw_reader || acc === 'all' || acc === null ? null : [...acc].sort();
		}
		// The remotes this island's client code can call: every remote module bundled anywhere in
		// its closure (static + dynamic). Sorted so the handoff is byte-stable across builds.
		const found = new Set<string>();
		for (const s of closure_all(fileName)) remotes_in(s, found);
		remotes[entryUrl] = [...found].sort();
		// the island's own components, over the same closure
		if (read_source) {
			let acc: IslandInteractivityFacts | undefined;
			const seen_files = new Set<string>();
			for (const s of closure_all(fileName)) {
				for (const id of bundle[s]?.moduleIds ?? []) {
					const clean = norm(id.split('?')[0]);
					if (seen_files.has(clean)) continue;
					seen_files.add(clean);
					const f = facts_of(id);
					if (f) acc = merge_facts(acc, f);
				}
			}
			if (acc) interactivity[entryUrl] = acc;
		}
	}
	return { js, css, page, page_keys, remotes, interactivity };
}

/** What an island's components do (the wake advisor's evidence) — see `interactivity_facts`. */
export interface IslandInteractivityFacts {
	handlers: number;
	state: number;
	effects: number;
	binds: number;
	actions: number;
	files: number;
}

const OWN_OR_DEP_RE = /\/node_modules\/|\/ogygia\/(?:src|dist)\//;
const HANDLER_RE = /\son[a-z]+\s*=\s*\{|\son:[a-z]+/g;
const STATE_RE = /\$state(?:\.raw)?\s*\(/g;
const EFFECT_RE = /\$effect(?:\.pre)?\s*\(/g;
const BIND_RE = /\sbind:[a-zA-Z]/g;
const ACTION_RE = /\suse:[a-zA-Z]/g;
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

/** Count a component source's interactivity markers. */
export function interactivity_facts(src: string): IslandInteractivityFacts {
	return {
		handlers: count(src, HANDLER_RE),
		state: count(src, STATE_RE),
		effects: count(src, EFFECT_RE),
		binds: count(src, BIND_RE),
		actions: count(src, ACTION_RE),
		files: 1
	};
}

function merge_facts(a: IslandInteractivityFacts | undefined, b: IslandInteractivityFacts): IslandInteractivityFacts {
	if (!a) return { ...b };
	return {
		handlers: a.handlers + b.handlers,
		state: a.state + b.state,
		effects: a.effects + b.effects,
		binds: a.binds + b.binds,
		actions: a.actions + b.actions,
		files: a.files + b.files
	};
}

/** Stable handoff path under Kit's `outDir`: client `generateBundle` writes; SSR reads at render
 *  (Kit is SSR-first). */
export function islandDepsHandoffPath(out_dir: string) {
	return path.join(out_dir, 'og-region-deps.json');
}

/**
 * `virtual:ogygia/island-deps` emitter — the SSR-render-time reader of the deps handoff.
 * Client: unused (modulepreload is SSR HTML). SSR: read the handoff JSON at *render* time — Kit
 * builds the server bundle before the client, so baking at `load()` would always be empty;
 * prerender/live SSR run after client generateBundle. Resolve via import.meta.url walk (not absolute
 * build-machine paths) so adapters find `output/server/og-region-deps.json` next to the server bundle.
 * `out_dir_rel` — Kit's `outDir` relative to the app root (`.svelte-kit` by default) — is the cwd
 * fallback for adapter-node / preview run from the app root.
 */
/** A CSS text that would close its own `<style>` cannot be inlined — link it instead. */
const STYLE_CLOSE_RE = /<\/style/i;

/**
 * INLINE REGION CSS. For every region CSS asset (`hrefs`: the union of the handoff's `css` and
 * `content_css` lists) whose bytes are under `threshold` — Kit's `inlineStyleThreshold`, the same
 * number Kit inlines its own route sheets under — keep the asset's text, keyed by its public href.
 * The render then emits `<style data-ogygia-region-css="href">` in place of a blocking `<link>`:
 * a page carrying twenty-five small island sheets (42 KB on a measured home page, twenty of them
 * under 3 KB) stops paying twenty-five requests before first paint. `0` = keep nothing (Kit's
 * default: never inline). Above the threshold, or not an emitted asset, → not in the map → linked.
 *
 * @internal Exported for unit tests.
 */
export function collect_inline_css(
	bundle: Record<string, { type: string; fileName?: string; source?: string | Uint8Array }>,
	hrefs: Iterable<string>,
	threshold: number
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!(threshold > 0)) return out;
	const by_href = new Map<string, { type: string; source?: string | Uint8Array }>();
	for (const key in bundle) {
		const item = bundle[key];
		if (item.type !== 'asset') continue;
		const file = item.fileName || key;
		by_href.set(file.startsWith('/') ? file : '/' + file, item);
	}
	for (const href of hrefs) {
		if (href in out) continue;
		const asset = by_href.get(href);
		if (!asset || asset.source == null) continue;
		const text =
			typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source);
		// Kit's unit: UTF-16 code units (`String.length`), "smaller than this value" — same rule.
		if (text.length >= threshold) continue;
		if (STYLE_CLOSE_RE.test(text)) continue;
		out[href] = text;
	}
	return out;
}

export function island_deps_module(
	ssr: boolean,
	is_dev: boolean,
	out_dir_rel = '.svelte-kit',
	preload_policy: 'all' | 'load' | 'none' = 'load'
): string {
	// `ogygia({ regions: { preload } })`, read by Region.svelte when it emits an island's hints:
	// 'load' hints only load-woken islands; 'all' hints every island (the rest at low priority);
	// 'none' hints nothing.
	const policy = `export const preloadPolicy = ${JSON.stringify(preload_policy)};\n`;
	if (!ssr)
		return `${policy}export function islandDeps(_entry) { return []; }\nexport function islandCss(_entry) { return []; }\nexport function islandCssInline(_href) { return null; }\nexport function contentCss(_id) { return []; }\nexport function islandReadsPage(_entry) { return false; }\nexport function islandPageKeys(_entry) { return null; }\nexport function islandRemotes(_entry) { return null; }\nexport function islandInteractivity(_entry) { return null; }\nexport function fnManifest() { return null; }`;
	// DEV: there is no built CSS asset to link (Vite serves component CSS only as importable
	// modules). The `entry` a region carries IS its dev module URL (moduleUrl / dev island_url),
	// so returning it lets the client `import()` it for its CSS side-effect — the same region-css
	// channel as prod's `<link>`, resolved for dev. `islandDeps` (JS modulepreload) is prod-only.
	// Content bodies need no dev entry here: a content module is in the SSR module graph, so
	// Vite dev already injects its scoped CSS (the leak only bites the PROD client build).
	// DEV always seeds the page (no chunk closure to consult) — the conservative side. Same for the
	// remotes: `null` = "may call anything" (fail-open).
	if (is_dev)
		return `${policy}export function islandDeps(_entry) { return []; }\nexport function islandCss(entry) { return entry ? [entry] : []; }\nexport function islandCssInline(_href) { return null; }\nexport function contentCss(_id) { return []; }\nexport function islandReadsPage(_entry) { return true; }\nexport function islandPageKeys(_entry) { return null; }\nexport function islandRemotes(_entry) { return null; }\nexport function islandInteractivity(_entry) { return null; }\nexport function fnManifest() { return null; }`;
	return (
		policy +
		`import fs from 'node:fs';\n` +
		`import path from 'node:path';\n` +
		`import { fileURLToPath } from 'node:url';\n` +
		// PRIMARY source: a string slot the client build patches in-place with the manifest JSON
		// (see writeBundle). Inlining it into the server bundle is what makes it survive serverless
		// tracing — Vercel/Netlify (@vercel/nft) only bundle *imported* files, not runtime fs reads,
		// so the co-located JSON below is dropped there. The fs walk stays as the fallback for
		// adapter-node & dev-preview (whole server dir ships). Unpatched, the token starts with '_'
		// (char 95), the guard is false, and we fall through to the walk.
		`const __OG_INLINE = '__OGYGIA_ISLAND_DEPS_INLINE__';\n` +
		// Defensive: a bad patch must degrade to the fs walk, never crash the server at import.
		`let cache = null;\n` +
		`try { if (__OG_INLINE.charCodeAt(0) === 123) cache = JSON.parse(__OG_INLINE); } catch {}\n` +
		`function candidates() {\n` +
		`  const out = [];\n` +
		`  try {\n` +
		`    let dir = path.dirname(fileURLToPath(import.meta.url));\n` +
		`    for (let i = 0; i < 8; i++) {\n` +
		`      out.push(path.join(dir, 'og-region-deps.json'));\n` +
		`      const parent = path.dirname(dir);\n` +
		`      if (parent === dir) break;\n` +
		`      dir = parent;\n` +
		`    }\n` +
		`  } catch {}\n` +
		`  if (typeof process !== 'undefined' && process.cwd) {\n` +
		`    const cwd = process.cwd();\n` +
		`    out.push(path.join(cwd, ${JSON.stringify(out_dir_rel)}, 'og-region-deps.json'));\n` +
		`    out.push(path.join(cwd, ${JSON.stringify(out_dir_rel)}, 'output', 'server', 'og-region-deps.json'));\n` +
		`  }\n` +
		`  return out;\n` +
		`}\n` +
		`function load() {\n` +
		`  if (cache) return cache;\n` +
		`  for (const p of candidates()) {\n` +
		`    try { cache = JSON.parse(fs.readFileSync(p, 'utf8')); return cache; } catch {}\n` +
		`  }\n` +
		`  cache = {};\n` +
		`  return cache;\n` +
		`}\n` +
		// Handoff shape: `{ js: { entryUrl: [...] }, css: { entryUrl: [...] } }`. A stale flat
		`// map (pre-css build) degrades gracefully: js falls back to the root, css to [].\n` +
		`function pick(kind, entry) {\n` +
		`  const all = load();\n` +
		`  const map = all && typeof all[kind] === 'object' ? all[kind] : kind === 'js' ? all : null;\n` +
		`  const list = map ? map[entry] : null;\n` +
		`  return Array.isArray(list) ? list : [];\n` +
		`}\n` +
		`export function islandDeps(entry) {\n` +
		`  return entry ? pick('js', entry) : [];\n` +
		`}\n` +
		`export function islandCss(entry) {\n` +
		`  return entry ? pick('css', entry) : [];\n` +
		`}\n` +
		// INLINE REGION CSS: the text of a region CSS asset the build kept under Kit's
		// `inlineStyleThreshold` (collect_inline_css), keyed by the same public href `islandCss`
		// hands out. `null` = link it (over the threshold, no threshold, or a pre-inline handoff).
		`export function islandCssInline(href) {\n` +
		`  const all = load();\n` +
		`  const map = all && typeof all.css_inline === 'object' && all.css_inline ? all.css_inline : null;\n` +
		`  if (!map || !href) return null;\n` +
		`  const v = map[href];\n` +
		`  return typeof v === 'string' ? v : null;\n` +
		`}\n` +
		`export function contentCss(id) {\n` +
		`  return id ? pick('content_css', id) : [];\n` +
		`}\n` +
		// Does this island's client closure read `$page`? FAIL-OPEN: no map (a pre-page handoff), or
		// an entry the build never saw (a foreign fragment's island mounted from another app) → true,
		// so the seed ships and nothing that might read it finds it missing.
		`export function islandReadsPage(entry) {\n` +
		`  const all = load();\n` +
		`  const map = all && typeof all.page === 'object' && all.page ? all.page : null;\n` +
		`  if (!map || !entry) return true;\n` +
		`  const v = map[entry];\n` +
		`  return v === undefined ? true : !!v;\n` +
		`}\n` +
		// SEED SHAPING: which top-level \`page.data\` keys this island's closure reads. FAIL-OPEN as
		// \`null\` ("ship all"): no map (a pre-shaping handoff), an entry the build never saw, or a
		// closure whose reads could not be pinned to literal keys.
		`export function islandPageKeys(entry) {\n` +
		`  const all = load();\n` +
		`  const map = all && typeof all.page_keys === 'object' && all.page_keys ? all.page_keys : null;\n` +
		`  if (!map || !entry) return null;\n` +
		`  const v = map[entry];\n` +
		`  return Array.isArray(v) ? v : null;\n` +
		`}\n` +
		// Which remotes (Kit id-hashes) this island's client closure can call — REMOTE SEED ONLY WHEN
		// REACHABLE. FAIL-OPEN as `null` ("may call anything"): no map (a pre-remotes handoff), or an
		// entry the build never saw (a foreign fragment's island) → every SSR-resolved remote seeds.
		`export function islandRemotes(entry) {\n` +
		`  const all = load();\n` +
		`  const map = all && typeof all.remotes === 'object' && all.remotes ? all.remotes : null;\n` +
		`  if (!map || !entry) return null;\n` +
		`  const v = map[entry];\n` +
		`  return Array.isArray(v) ? v : null;\n` +
		`}\n` +
		// WAKE ADVISOR facts per entry (handlers / $state / bind: counts over the island's own
		// components), for the profiler's Islands table. `null` = the handoff has none.
		`export function islandInteractivity(entry) {\n` +
		`  const all = load();\n` +
		`  const map = all && typeof all.interactivity === 'object' && all.interactivity ? all.interactivity : null;\n` +
		`  if (!map || !entry) return null;\n` +
		`  const v = map[entry];\n` +
		`  return v && typeof v === 'object' ? v : null;\n` +
		`}\n` +
		// og.$ factories for the page-inline registration script (CSP-clean prod path):
		// written by the CLIENT build's writeBundle, read here at SSR render time — the
		// same ordering-safe channel islandCss uses.
		`export function fnManifest() {\n` +
		`  const m = load().fn_manifest;\n` +
		`  return m && typeof m === 'object' && Object.keys(m).length ? m : null;\n` +
		`}\n`
	);
}
