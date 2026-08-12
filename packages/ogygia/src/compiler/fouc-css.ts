/**
 * csr=false FOUC without dual-owning island component JS.
 *
 * Kit only links stylesheets from the *client* page graph. Importing the authored `.svelte`
 * for that purpose (0.4.1) puts the same default-export module in the page graph and the
 * `emitFile` island entry → Rolldown thin-facades `ogygia-island.*`.
 *
 * Hosts instead import `virtual:ogygia/fouc-css/<encoded>.js` which side-effect-imports:
 *   - plain `.css` files reachable from the entry
 *   - `virtual:ogygia/fouc-scoped/<encoded>.css` for each `.svelte` with a `<style>` block
 * Aggregator ids end in `.js` and scoped ids in `.css` so vite-plugin-svelte / Vite classify
 * them correctly (never as `.svelte` components). Scoped CSS is compiled with the real
 * filename so hashes match SSR.
 */

import fs from 'node:fs';
import path from 'node:path';
import { compile, parse } from 'svelte/compiler';
import { walk } from 'estree-walker';

export const FOUC_CSS_PREFIX = 'virtual:ogygia/fouc-css/';
export const FOUC_SCOPED_PREFIX = 'virtual:ogygia/fouc-scoped/';

const PATH_SEP = /[/\\]/;
const SCRIPT_TAG = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const STYLE_OPEN = /<style\b/i;
const STYLE_BODY = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const STYLE_EXT = /\.(css|scss|sass|less|styl|stylus|pcss)(?:\?|$)/i;
const SVELTE_EXT = /\.svelte(?:\?|$)/i;
const IMPORT_SPEC =
	/import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+\.(?:svelte|css|scss|sass|less|styl|pcss)(?:\?[^"']*)?)["']/g;

/** @param {string} relPosix */
export function foucCssVirtualId(relPosix: string) {
	return FOUC_CSS_PREFIX + encodeURIComponent(relPosix.split(PATH_SEP).join('/')) + '.js';
}

/** @param {string} relPosix */
export function foucScopedVirtualId(relPosix: string) {
	return FOUC_SCOPED_PREFIX + encodeURIComponent(relPosix.split(PATH_SEP).join('/')) + '.css';
}

/** @param {string} id */
export function isFoucCssId(id: string) {
	const bare = id.startsWith('\0') ? id.slice(1) : id;
	return bare.startsWith(FOUC_CSS_PREFIX) && bare.endsWith('.js');
}

/** @param {string} id */
export function isFoucScopedId(id: string) {
	const bare = id.startsWith('\0') ? id.slice(1) : id;
	return bare.startsWith(FOUC_SCOPED_PREFIX) && bare.endsWith('.css');
}

/** @param {string} id */
export function foucRelFromId(id: string) {
	const bare = id.startsWith('\0') ? id.slice(1) : id;
	let encoded = null;
	if (bare.startsWith(FOUC_CSS_PREFIX) && bare.endsWith('.js')) {
		encoded = bare.slice(FOUC_CSS_PREFIX.length, -'.js'.length);
	} else if (bare.startsWith(FOUC_SCOPED_PREFIX) && bare.endsWith('.css')) {
		encoded = bare.slice(FOUC_SCOPED_PREFIX.length, -'.css'.length);
	}
	if (encoded == null) return null;
	try {
		return decodeURIComponent(encoded);
	} catch {
		return encoded;
	}
}

/**
 * Resolve a static import specifier against an importer file + `$lib`.
 * @param {string} spec
 * @param {string} importerAbs
 * @param {string} libDir
 */
export function resolveFoucImportSpec(spec: string, importerAbs: string, libDir: string) {
	if (spec === '$lib' || spec.startsWith('$lib/')) {
		return path.join(libDir, spec === '$lib' ? '' : spec.slice('$lib/'.length));
	}
	if (spec.startsWith('.')) {
		return path.resolve(path.dirname(importerAbs), spec);
	}
	return null;
}

/**
 * Collect side-effect import specs that pull island CSS into the client graph without JS.
 * @param {string} entryAbs absolute path to the island entry `.svelte`
 * @param {{ root: string, libDir: string, readFile?: (p: string) => string | null }} opts
 */
export function buildFoucCssModuleSource(
	entryAbs: string,
	opts: {
		root: string;
		libDir: string;
		readFile?: (p: string) => string | null;
	}
) {
	const read =
		opts.readFile ||
		((p: string) => {
			try {
				return fs.readFileSync(p, 'utf8');
			} catch {
				return null;
			}
		});
	const posix_rel = (abs: string) => path.relative(opts.root, abs).split(PATH_SEP).join('/');

	/** @type {Set<string>} */
	const imports = new Set();
	/** @type {Set<string>} */
	const seen_svelte = new Set();

	const visit_svelte = (abs: string) => {
		const norm = path.normalize(abs);
		if (seen_svelte.has(norm)) return;
		seen_svelte.add(norm);
		const source = read(norm);
		if (source == null) return;

		const rel = posix_rel(norm);
		if (svelteHasStyle(source)) {
			imports.add(foucScopedVirtualId(rel));
		}

		for (const spec of listStaticImportSpecs(source, norm)) {
			const resolved = resolveFoucImportSpec(spec, norm, opts.libDir);
			if (!resolved) continue;
			const clean = resolved.split('?')[0];
			if (STYLE_EXT.test(clean)) {
				imports.add(clean);
			} else if (SVELTE_EXT.test(clean) || clean.endsWith('.svelte')) {
				visit_svelte(clean);
			}
		}
	};

	visit_svelte(entryAbs);

	if (imports.size === 0) {
		return 'export {}';
	}
	return [...imports].map((s) => `import ${JSON.stringify(s)};`).join('\n') + '\n';
}

/**
 * Compile scoped CSS for a `.svelte` file (filename must match SSR for hash stability).
 * @param {string} abs
 * @param {string} source
 */
export function compileFoucScopedCss(abs: string, source: string) {
	const stripped = source.replace(SCRIPT_TAG, '');
	try {
		const result = compile(stripped, {
			filename: abs,
			generate: 'client',
			css: 'external',
			discloseVersion: false
		});
		return result.css?.code ?? '';
	} catch {
		return extractRawStyleBodies(source);
	}
}

/** @param {string} source */
export function svelteHasStyle(source: string) {
	return STYLE_OPEN.test(source);
}

/** @param {string} source */
function extractRawStyleBodies(source: string) {
	return [...source.matchAll(STYLE_BODY)].map((m) => m[1]).join('\n');
}

/**
 * Static import sources from a Svelte file's script blocks (default + side-effect).
 * @param {string} source
 * @param {string} filename
 */
export function listStaticImportSpecs(source: string, filename: string) {
	/** @type {string[]} */
	const specs: string[] = [];
	try {
		const ast = parse(source, { filename, modern: true });
		const scripts = [ast.instance, ast.module].filter(Boolean);
		for (const block of scripts) {
			const content = /** @type {{ content?: { type?: string } }} */ (block)?.content;
			if (!content || content.type !== 'Program') continue;
			walk(content, {
				enter(node) {
					if (node.type !== 'ImportDeclaration') return;
					const src = /** @type {{ value?: unknown }} */ (node.source)?.value;
					if (typeof src === 'string') specs.push(src);
				}
			});
		}
	} catch {
		for (const m of source.matchAll(IMPORT_SPEC)) {
			specs.push(m[1]);
		}
	}
	return specs;
}
