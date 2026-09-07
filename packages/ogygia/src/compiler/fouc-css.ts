/**
 * csr=false FOUC without dual-owning island component JS.
 *
 * Kit only links stylesheets from the *client* page graph. Importing the authored `.svelte`
 * for that purpose (0.4.1) puts the same default-export module in the page graph and the
 * `emitFile` island entry → Rolldown thin-facades `og-region.*`.
 *
 * Hosts instead import `virtual:ogygia/fouc-css/<encoded>.js` which side-effect-imports:
 *   - plain `.css` files reachable from the entry
 *   - `virtual:ogygia/fouc-scoped/<encoded>.css` for each `.svelte` with a `<style>` block
 * Aggregator ids end in `.js` and scoped ids in `.css` so vite-plugin-svelte / Vite classify
 * them correctly (never as `.svelte` components). Scoped CSS is compiled with the real
 * filename so hashes match SSR.
 */

import { fs, path } from './host.js';
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
const WIN_DRIVE_RE = /^[a-zA-Z]:/;
const PARENT_TRAVERSAL_RE = /(^|[\\/])\.\.([\\/]|$)/;

/** @param relPosix */
export function foucCssVirtualId(relPosix: string) {
	return FOUC_CSS_PREFIX + encodeURIComponent(relPosix.split(PATH_SEP).join('/')) + '.js';
}

/** @param relPosix */
export function foucScopedVirtualId(relPosix: string) {
	return FOUC_SCOPED_PREFIX + encodeURIComponent(relPosix.split(PATH_SEP).join('/')) + '.css';
}

/** @param id */
export function isFoucCssId(id: string) {
	const bare = id.startsWith('\0') ? id.slice(1) : id;
	return bare.startsWith(FOUC_CSS_PREFIX) && bare.endsWith('.js');
}

/** @param id */
export function isFoucScopedId(id: string) {
	const bare = id.startsWith('\0') ? id.slice(1) : id;
	return bare.startsWith(FOUC_SCOPED_PREFIX) && bare.endsWith('.css');
}

/** @param id */
export function foucRelFromId(id: string) {
	const bare = id.startsWith('\0') ? id.slice(1) : id;
	let encoded = null;
	if (bare.startsWith(FOUC_CSS_PREFIX) && bare.endsWith('.js')) {
		encoded = bare.slice(FOUC_CSS_PREFIX.length, -'.js'.length);
	} else if (bare.startsWith(FOUC_SCOPED_PREFIX) && bare.endsWith('.css')) {
		encoded = bare.slice(FOUC_SCOPED_PREFIX.length, -'.css'.length);
	}
	if (encoded == null) return null;
	let rel: string;
	try {
		rel = decodeURIComponent(encoded);
	} catch {
		rel = encoded;
	}
	// SECURITY: this rel is `path.join(root, rel)` + `readFileSync` in the dev `load()` hook. A FOUC
	// id is minted from a module path in our own graph, so a legit rel is always root-relative with no
	// `..`. Reject traversal / absolute specifiers — otherwise a crafted request to the dev server
	// (`…/fouc-scoped/..%2F..%2Fetc%2Fpasswd.css`) would read files outside the project (Vite's
	// `server.fs.allow` does NOT cover a plugin's own `fs.readFileSync`). Mirrors content/source.ts.
	if (
		rel.startsWith('/') ||
		rel.startsWith('\\') ||
		WIN_DRIVE_RE.test(rel) ||
		PARENT_TRAVERSAL_RE.test(rel)
	) {
		return null;
	}
	return rel;
}

/**
 * Resolve a static import specifier against an importer file + `$lib`.
 * @param spec
 * @param importerAbs
 * @param libDir
 */
/** One resolved Vite alias (`resolve.alias`, normalized) — Kit's `kit.alias` entries arrive here. */
export interface FoucAlias {
	find: string | RegExp;
	replacement: string;
}

export function resolveFoucImportSpec(
	spec: string,
	importerAbs: string,
	libDir: string,
	alias: readonly FoucAlias[] = []
) {
	if (spec === '$lib' || spec.startsWith('$lib/')) {
		return path.join(libDir, spec === '$lib' ? '' : spec.slice('$lib/'.length));
	}
	if (spec.startsWith('.')) {
		return path.resolve(path.dirname(importerAbs), spec);
	}
	// App aliases (`$lib_x`, `@scope/pkg` → a source dir): the same table Vite resolves with.
	for (const a of alias) {
		if (typeof a.find === 'string') {
			if (spec === a.find) return a.replacement;
			if (spec.startsWith(a.find + '/')) return a.replacement + spec.slice(a.find.length);
		} else if (a.find.test(spec)) {
			return spec.replace(a.find, a.replacement);
		}
	}
	return null;
}

/**
 * Collect side-effect import specs that pull island CSS into the client graph without JS.
 * @param entryAbs absolute path to the island entry `.svelte`
 * @param opts
 */
export function buildFoucCssModuleSource(
	entryAbs: string,
	opts: {
		root: string;
		libDir: string;
		readFile?: (p: string) => string | null;
	}
) {
	const entries = collectFoucCssReachable(entryAbs, opts);
	const posix_rel = (abs: string) => path.relative(opts.root, abs).split(PATH_SEP).join('/');
	const imports = entries.map((e) =>
		e.kind === 'scoped' ? foucScopedVirtualId(posix_rel(e.abs)) : e.abs
	);
	if (imports.length === 0) {
		return 'export {}';
	}
	return imports.map((s) => `import ${JSON.stringify(s)};`).join('\n') + '\n';
}

/**
 * The transitive CSS-reachability walk under `buildFoucCssModuleSource`, exported on its own for the
 * server-router CSS registry (link/router-css.ts): from a component entry, in DISCOVERY ORDER (the
 * cascade order the aggregator has always imported in), every `.svelte` with a `<style>` block
 * (`kind: 'scoped'`) and every plain style-file import (`kind: 'css'`) reachable through the
 * component tree. Abs paths. Same resolution rules as the aggregator, so both stay in lockstep.
 */
export function collectFoucCssReachable(
	entryAbs: string,
	opts: {
		root: string;
		libDir: string;
		readFile?: (p: string) => string | null;
		/** app aliases to follow (`$lib_x/…`, `@scope/pkg/…` → source dirs) */
		alias?: readonly FoucAlias[];
	}
): Array<{ kind: 'scoped' | 'css'; abs: string }> {
	const read =
		opts.readFile ||
		((p: string) => {
			try {
				return fs.readFileSync(p, 'utf8');
			} catch {
				return null;
			}
		});

	const entries: Array<{ kind: 'scoped' | 'css'; abs: string }> = [];
	const seen_css = new Set<string>();
	const seen_svelte = new Set<string>();

	const visit_svelte = (abs: string) => {
		const norm = path.normalize(abs);
		if (seen_svelte.has(norm)) return;
		seen_svelte.add(norm);
		const source = read(norm);
		if (source == null) return;

		if (svelteHasStyle(source)) {
			entries.push({ kind: 'scoped', abs: norm });
		}

		for (const spec of listStaticImportSpecs(source, norm)) {
			const resolved = resolveFoucImportSpec(spec, norm, opts.libDir, opts.alias);
			if (!resolved) continue;
			const clean = resolved.split('?')[0];
			if (STYLE_EXT.test(clean)) {
				if (!seen_css.has(clean)) {
					seen_css.add(clean);
					entries.push({ kind: 'css', abs: clean });
				}
			} else if (SVELTE_EXT.test(clean) || clean.endsWith('.svelte')) {
				visit_svelte(clean);
			}
		}
	};

	visit_svelte(entryAbs);
	return entries;
}

/**
 * Compile scoped CSS for a `.svelte` file (filename must match SSR for hash stability).
 * @param abs
 * @param source
 */
export function compileFoucScopedCss(
	abs: string,
	source: string,
	opts: {
		/** Keep the `<script>` (already free of TS/dialects): a template reading `$store` from an
		 *  imported store, or any script-declared name, only compiles WITH its script. Stripping it
		 *  (the default, for sources that may still carry TypeScript) throws on such a template and
		 *  falls back to UNSCOPED style bodies — which match nothing the SSR'd markup carries. */
		keepScript?: boolean;
	} = {}
) {
	const input = opts.keepScript ? source : source.replace(SCRIPT_TAG, '');
	try {
		const result = compile(input, {
			filename: abs,
			generate: 'client',
			css: 'external',
			discloseVersion: false,
			// a hole component may `await` at the top level (async Svelte); the CSS is the same either way
			experimental: { async: true }
		});
		return result.css?.code ?? '';
	} catch (err) {
		if (opts.keepScript) {
			console.warn(
				`[ogygia] scoped CSS for ${abs} could not be compiled (${(err as Error).message.split('\n')[0]}) — shipping its style bodies unscoped`
			);
		}
		return extractRawStyleBodies(source);
	}
}

/** @param source */
export function svelteHasStyle(source: string) {
	return STYLE_OPEN.test(source);
}

/**
 * Unwrap `:global(SELECTOR)` → `SELECTOR`. `:global(...)` is a Svelte construct, not CSS — left
 * literal in a raw style body (the fallback below never runs the Svelte compiler) the browser drops
 * the whole rule. This fallback already ships styles UNSCOPED, so a global-wrapped selector is just
 * the selector. Balanced-paren scan so `:global(x:not(.y))` unwraps to `x:not(.y)`, not `x:not(.y`.
 */
function unwrap_global(css: string) {
	let out = '';
	let i = 0;
	while (i < css.length) {
		const at = css.indexOf(':global(', i);
		if (at === -1) {
			out += css.slice(i);
			break;
		}
		out += css.slice(i, at);
		let depth = 1;
		let j = at + 8; // past ':global('
		for (; j < css.length && depth > 0; j++) {
			if (css[j] === '(') depth++;
			else if (css[j] === ')') depth--;
		}
		// css.slice(inner) excludes the closing ')' consumed by the loop.
		out += css.slice(at + 8, j - 1);
		i = j;
	}
	return out;
}

/** @param source */
function extractRawStyleBodies(source: string) {
	return unwrap_global([...source.matchAll(STYLE_BODY)].map((m) => m[1]).join('\n'));
}

/**
 * Static import sources from a Svelte file's script blocks (default + side-effect).
 * @param source
 * @param filename
 */
export function listStaticImportSpecs(source: string, filename: string) {
	const specs: string[] = [];
	try {
		const ast = parse(source, { filename, modern: true });
		const scripts = [ast.instance, ast.module].filter(Boolean);
		for (const block of scripts) {
			const content = block?.content;
			if (!content || content.type !== 'Program') continue;
			walk(content, {
				enter(node) {
					if (node.type !== 'ImportDeclaration') return;
					const src = node.source?.value;
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
