/**
 * Whole-program island dependency collection — from a finished client bundle, the transitive static
 * import + CSS chains for each `og-region.<id>.js` facade, so SSR can `modulepreload` a hydrate
 * island's hashed dependency chunks (Vite's auto graph does not cover `@vite-ignore` `import(entry)`).
 * Pure over the bundle it is handed. Covered by unit tests.
 */
import { path } from '../host.js';

/** Deterministic island facade filename (content-hashed Vite deps are separate). */
const ISLAND_FACADE_RE = /(?:^|\/)og-region\.[0-9a-f]+\.js$/;

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
			/** Vite/rolldown-vite chunk metadata — `importedCss` lists the CSS assets a chunk owns. */
			viteMetadata?: { importedCss?: Set<string> | string[] };
		}
	>
): { js: Record<string, string[]>; css: Record<string, string[]> } {
	const js: Record<string, string[]> = {};
	const css: Record<string, string[]> = {};

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
	}
	return { js, css };
}

/** Stable handoff path: client `generateBundle` writes; SSR reads at render (Kit is SSR-first). */
export function islandDepsHandoffPath(root: string) {
	return path.join(root, '.svelte-kit', 'og-region-deps.json');
}

/**
 * `virtual:ogygia/island-deps` emitter — the SSR-render-time reader of the deps handoff.
 * Client: unused (modulepreload is SSR HTML). SSR: read the handoff JSON at *render* time — Kit
 * builds the server bundle before the client, so baking at `load()` would always be empty;
 * prerender/live SSR run after client generateBundle. Resolve via import.meta.url walk (not absolute
 * build-machine paths) so adapters find `output/server/og-region-deps.json` next to the server bundle.
 */
export function island_deps_module(ssr: boolean, is_dev: boolean): string {
	if (!ssr)
		return `export function islandDeps(_entry) { return []; }\nexport function islandCss(_entry) { return []; }\nexport function contentCss(_id) { return []; }\nexport function fnManifest() { return null; }`;
	// DEV: there is no built CSS asset to link (Vite serves component CSS only as importable
	// modules). The `entry` a region carries IS its dev module URL (moduleUrl / dev island_url),
	// so returning it lets the client `import()` it for its CSS side-effect — the same region-css
	// channel as prod's `<link>`, resolved for dev. `islandDeps` (JS modulepreload) is prod-only.
	// Content bodies need no dev entry here: a content module is in the SSR module graph, so
	// Vite dev already injects its scoped CSS (the leak only bites the PROD client build).
	if (is_dev)
		return `export function islandDeps(_entry) { return []; }\nexport function islandCss(entry) { return entry ? [entry] : []; }\nexport function contentCss(_id) { return []; }\nexport function fnManifest() { return null; }`;
	return (
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
		`    out.push(path.join(cwd, '.svelte-kit', 'og-region-deps.json'));\n` +
		`    out.push(path.join(cwd, '.svelte-kit', 'output', 'server', 'og-region-deps.json'));\n` +
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
		`export function contentCss(id) {\n` +
		`  return id ? pick('content_css', id) : [];\n` +
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
