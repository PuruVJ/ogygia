/**
 * Whole-program build-output side effects — the work the adapter's `writeBundle` does AFTER the
 * client bundle is on disk: the content-leak guardrail, and writing / inlining the island-deps
 * handoff so SSR can `modulepreload` a hydrate island's chunks and style a server-picked hole. Pure
 * over the finished bundle + the app root (fs is the only side effect); the adapter owns only the
 * Vite `this.getFileName` resolution and the trigger.
 */
import fs from 'node:fs';
import path from 'node:path';
import { islandDepsHandoffPath } from './island-deps.js';

const CORPUS_RE = /\.(svx|md)(\?|$)/;
/** A `?…type=style…` / `lang.css` sub-import id — a CSS face, never a corpus JS leak. */
const CONTENT_STYLE_QUERY_RE = /[?&](?:type=style|lang\.css)/;

/**
 * Guardrail: a content collection must never reach a CLIENT chunk. Ground truth is the finished
 * bundle. A compiled corpus module (.svx/.md) in a client chunk means a `content()` collection was
 * imported into client-shipped code (usually an island), which drags its eager `import.meta.glob` —
 * every doc — into the browser. On a csr=false site the corpus renders server-side and should never
 * appear here, so any hit is a real leak. A warning, not a throw: the guardrail must never break a build.
 */
export function warn_content_leaks(
	bundle: Record<string, unknown>,
	root: string,
	is_island_path: (id: string) => boolean
) {
	try {
		const leaks: Array<{ chunk: string; modules: string[] }> = [];
		for (const [key, chunk] of Object.entries(bundle)) {
			if ((chunk as { type?: string }).type !== 'chunk') continue;
			const ids: string[] =
				(chunk as { moduleIds?: string[] }).moduleIds ??
				Object.keys((chunk as { modules?: Record<string, unknown> }).modules ?? {});
			// A `?…type=style…`/`lang.css` sub-import is the content module's CSS FACE, emitted on
			// purpose (see the client-leg content-CSS emit) — it carries no corpus JS, so it is not
			// a leak. Only a real corpus JS module counts.
			const corpus = ids.filter(
				(id) => CORPUS_RE.test(id) && !is_island_path(id) && !CONTENT_STYLE_QUERY_RE.test(id)
			);
			if (corpus.length) leaks.push({ chunk: (chunk as { fileName?: string }).fileName ?? key, modules: corpus });
		}
		if (leaks.length) {
			const all = [...new Set(leaks.flatMap((l) => l.modules))];
			const sample = all.slice(0, 5).map((m) => '    ' + path.relative(root, m.split('?')[0])).join('\n');
			console.warn(
				`[ogygia] content leaked into the CLIENT bundle: ${all.length} corpus module(s) (.svx/.md) shipped to the browser (in chunk '${leaks[0].chunk}').\n` +
					`  A content() collection was imported into client-shipped code — usually an island — which drags its eager import.meta.glob (every doc) in.\n` +
					`  Fix: keep the collection in a server-only module (or a .remote.ts) and feed islands DATA (refs) via props or a remote, never the collection itself.\n` +
					`${sample}${all.length > 5 ? '\n    …' : ''}`
			);
		}
	} catch {
		/* a guardrail must never break the build */
	}
}

/**
 * Write the island-deps handoff JSON (the map SSR reads at render): the stable `.svelte-kit` path,
 * an adapter-friendly copy next to the server bundle, AND an in-place inline into every server chunk
 * that carries the token slot — inlining is what makes it survive serverless tracing (@vercel/nft
 * only bundles *imported* files, not runtime fs reads, so the co-located JSON is dropped there; that
 * is why held/dual regions that cross the wire rendered unstyled on Vercel/Netlify). Unpatched builds
 * keep the fs fallback (adapter-node, dev-preview).
 */
export function emit_island_deps_handoff(root: string, json: string) {
	const handoff = islandDepsHandoffPath(root);
	fs.mkdirSync(path.dirname(handoff), { recursive: true });
	fs.writeFileSync(handoff, json);
	// Adapter-friendly copy next to the server bundle (Kit SSR out already exists).
	const server_copy = path.join(root, '.svelte-kit', 'output', 'server', 'og-region-deps.json');
	try {
		fs.mkdirSync(path.dirname(server_copy), { recursive: true });
		fs.writeFileSync(server_copy, json);
	} catch {
		/* ignore — handoff path is enough for prerender */
	}

	try {
		const server_dir = path.join(root, '.svelte-kit', 'output', 'server');
		const token = '__OGYGIA_ISLAND_DEPS_INLINE__';
		// Escape for BOTH quote styles: the SSR bundler may emit the slot in single OR double
		// quotes, and an escaped quote is valid in either literal — so this is safe regardless.
		const inline = json
			.replace(/\\/g, '\\\\')
			.replace(/'/g, "\\'")
			.replace(/"/g, '\\"')
			.replace(/\u2028/g, '\\u2028')
			.replace(/\u2029/g, '\\u2029');
		const patch_server = (dir: string) => {
			let entries;
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const full = path.join(dir, e.name);
				if (e.isDirectory()) {
					patch_server(full);
					continue;
				}
				if (!e.name.endsWith('.js')) continue;
				let code;
				try {
					code = fs.readFileSync(full, 'utf8');
				} catch {
					continue;
				}
				if (!code.includes(token)) continue;
				fs.writeFileSync(full, code.split(token).join(inline));
			}
		};
		patch_server(server_dir);
	} catch {
		/* ignore — fs fallback still serves adapter-node / preview */
	}
}
