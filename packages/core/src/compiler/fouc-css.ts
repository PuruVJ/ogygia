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

import { fs, path } from './host.ts';
import { compile, parse } from 'svelte/compiler';
import { walk } from 'estree-walker';
import { unscoped_marker } from '../unscoped-css.ts';
import { blank_styles } from './blank-styles.ts';
import { BarrelIndex } from './debarrel/barrel.ts';
import { analyze_exports, analyze_imports } from './debarrel/parse.ts';

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
export function foucCssVirtualId(relPosix: string): string {
	return FOUC_CSS_PREFIX + encodeURIComponent(relPosix.split(PATH_SEP).join('/')) + '.js';
}

/** @param relPosix */
export function foucScopedVirtualId(relPosix: string): string {
	return FOUC_SCOPED_PREFIX + encodeURIComponent(relPosix.split(PATH_SEP).join('/')) + '.css';
}

/** @param id */
export function isFoucCssId(id: string): boolean {
	const bare = id.startsWith('\0') ? id.slice(1) : id;
	return bare.startsWith(FOUC_CSS_PREFIX) && bare.endsWith('.js');
}

/** @param id */
export function isFoucScopedId(id: string): boolean {
	const bare = id.startsWith('\0') ? id.slice(1) : id;
	return bare.startsWith(FOUC_SCOPED_PREFIX) && bare.endsWith('.css');
}

/** @param id */
export function foucRelFromId(id: string): string | null {
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
): string | null {
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
export async function buildFoucCssModuleSource(
	entryAbs: string,
	opts: CssReachOptions
): Promise<string> {
	const entries = await collectFoucCssReachable(entryAbs, opts);
	const posix_rel = (abs: string) => path.relative(opts.root, abs).split(PATH_SEP).join('/');
	const imports: string[] = [];
	for (const e of entries) {
		if (e.kind !== 'scoped') imports.push(e.abs);
		else {
			// (a scoped sheet is addressed by its root-relative path — the dev `load` refuses `..` — so
			// a component outside the app's root cannot ride this module)
			const rel = posix_rel(e.abs);
			if (!rel.startsWith('../') && !path.isAbsolute(rel)) imports.push(foucScopedVirtualId(rel));
		}
	}
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
export interface CssReachOptions {
	root: string;
	libDir: string;
	readFile?: (p: string) => string | null;
	/** app aliases to follow (`$lib_x/…`, `@scope/pkg/…` → source dirs) — the fallback resolver's */
	alias?: readonly FoucAlias[];
	/**
	 * The bundler's own resolver (Vite's `this.resolve`): a package specifier through its `exports`
	 * (a TypeScript entry included), a workspace link, an alias — whatever the build resolves. Without
	 * it (a unit test, a host with no bundler) `$lib`, relative paths and `alias` only.
	 */
	resolve?: (spec: string, importer: string) => Promise<string | null>;
}

const SCRIPT_MODULE_EXT = /\.(?:[cm]?[jt]sx?|svelte\.[jt]s)$/;
const RESOLVE_SUFFIXES = ['', '.ts', '.js', '/index.ts', '/index.js'];
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/;
/** every name a module exports — a namespace import, or a module reached for its own code */
const ALL = '*';
/** the barrel index of each bundler resolver (one per build's legs: see `collectFoucCssReachable`) */
const barrel_indexes = new WeakMap<object, BarrelIndex>();

/**
 * THE CSS A COMPONENT TREE REACHES — every `.svelte` with a `<style>` block (`kind: 'scoped'`) and
 * every plain style-file import (`kind: 'css'`), in DISCOVERY ORDER (the cascade order the aggregator
 * has always imported in). Abs paths.
 *
 * A subtree no client chunk carries (a server-only hole, a router page, a lake) gets its CSS from
 * here, so this walk must reach what the bundler reaches — a component imported through a workspace
 * package's TypeScript barrel came back unstyled: its specifier was not resolved, and a `.ts` module
 * was a dead end. So:
 * - specifiers resolve through the bundler's resolver (`opts.resolve`) when the build has one;
 * - a `.svelte` file is a component: all of it renders, so every import of it is followed;
 * - a script module is followed by the NAMES taken from it: through a barrel (the debarrel index —
 *   nested barrels, `export *`), each name to its leaf, so a barrel of twenty components brings the
 *   CSS of the two imported; a module with code of its own, every import it makes (its code may
 *   render them). A dependency's own JavaScript (`node_modules`, not a barrel) is not walked: a
 *   package ships compiled code, its components as `.svelte` files a barrel names.
 */
export async function collectFoucCssReachable(
	entryAbs: string,
	opts: CssReachOptions
): Promise<Array<{ kind: 'scoped' | 'css'; abs: string }>> {
	const read =
		opts.readFile ||
		((p: string) => {
			try {
				return fs.readFileSync(p, 'utf8');
			} catch {
				return null;
			}
		});
	const resolve = async (spec: string, importer: string): Promise<string | null> => {
		if (opts.resolve) {
			const id = await opts.resolve(spec, importer);
			return id ? path.normalize(id.split('?')[0]) : null;
		}
		const base = resolveFoucImportSpec(spec, importer, opts.libDir, opts.alias);
		if (!base) return null;
		const clean = base.split('?')[0];
		if (STYLE_EXT.test(clean) || SVELTE_EXT.test(clean)) return path.normalize(clean);
		for (const suffix of RESOLVE_SUFFIXES) {
			const candidate = path.normalize(clean + suffix);
			if (read(candidate) != null) return candidate;
		}
		return null;
	};
	// ONE barrel index per resolver: a build's walks (every hole, every router root) share its parsed
	// barrels instead of each re-reading them
	let barrels = opts.resolve ? barrel_indexes.get(opts.resolve) : undefined;
	if (!barrels) {
		barrels = new BarrelIndex({
			read: (id) => read(id),
			resolve: (spec, importer) => resolve(spec, importer),
			candidate: () => true,
			forced: () => false,
			kept: () => false,
			follow_packages: true
		});
		if (opts.resolve) barrel_indexes.set(opts.resolve, barrels);
	}

	const entries: Array<{ kind: 'scoped' | 'css'; abs: string }> = [];
	const seen_css = new Set<string>();
	const seen_svelte = new Set<string>();
	/** script module → the names already followed (`*`: all of them) */
	const seen_names = new Map<string, Set<string>>();

	const visit = async (abs: string, names: ReadonlySet<string>, spec: string): Promise<void> => {
		if (STYLE_EXT.test(abs)) {
			if (!seen_css.has(abs)) {
				seen_css.add(abs);
				entries.push({ kind: 'css', abs });
			}
		} else if (SVELTE_EXT.test(abs)) {
			await visit_svelte(abs);
		} else if (SCRIPT_MODULE_EXT.test(abs)) {
			await visit_script(abs, names, spec);
		}
	};

	const follow = async (
		decls: ReadonlyArray<{ source: string; names: Set<string> }>,
		importer: string
	) => {
		for (const d of decls) {
			const resolved = await resolve(d.source, importer);
			if (resolved) await visit(resolved, d.names, d.source);
		}
	};

	const visit_svelte = async (abs: string) => {
		if (seen_svelte.has(abs)) return;
		seen_svelte.add(abs);
		const source = read(abs);
		if (source == null) return;
		if (svelteHasStyle(source)) entries.push({ kind: 'scoped', abs });
		await follow(listStaticImports(source, abs), abs);
	};

	const visit_script = async (abs: string, names: ReadonlySet<string>, spec: string) => {
		let done = seen_names.get(abs);
		if (!done) seen_names.set(abs, (done = new Set()));
		if (done.has(ALL)) return;
		const wanted = names.has(ALL) ? [ALL] : [...names].filter((n) => !done.has(n));
		if (!wanted.length) return;
		for (const n of wanted) done.add(n);
		// a barrel: each name to its leaf (only the names taken)
		const map = await barrels.map(abs, spec);
		if (map && !wanted.includes(ALL)) {
			const own: string[] = [];
			for (const n of wanted) {
				const entry = map.entries.get(n);
				if (entry && typeof entry === 'object')
					await visit(entry.id, new Set(['namespace' in entry ? ALL : entry.name]), entry.id);
				else own.push(n); // its own code, ambiguous, or unseen (an opaque star): the module itself
			}
			if (!own.length && !map.opaque) return;
		}
		// a module with code of its own (or every name of a barrel): every import it makes
		if (NODE_MODULES_RE.test(abs)) return;
		const code = read(abs);
		if (code == null) return;
		const decls = analyze_imports(code, abs);
		if (!decls) return;
		await follow(
			decls
				.filter((d) => !d.type_only)
				.map((d) => ({
					source: d.source,
					names: new Set(
						d.side_effect
							? []
							: d.specs
									.filter((s) => !s.type_only)
									.map((s) => (s.kind === 'namespace' ? ALL : s.imported))
					)
				})),
			abs
		);
		// (`export … from` in a module with code of its own: what it re-exports may be what renders)
		const shape = analyze_exports(code, abs);
		if (shape)
			await follow(
				shape.exports.flatMap((e) =>
					e.kind === 'reexport' && !e.type_only
						? [{ source: e.source, names: new Set([e.imported]) }]
						: e.kind === 'star' && !e.type_only
							? [{ source: e.source, names: new Set([ALL]) }]
							: e.kind === 'star_ns'
								? [{ source: e.source, names: new Set([ALL]) }]
								: []
				),
				abs
			);
	};

	await visit_svelte(path.normalize(entryAbs));
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
		 *  throws on such a template and falls back to UNSCOPED style bodies — which match nothing
		 *  the SSR'd markup carries. Without it (a source that may still carry TypeScript), the
		 *  source is tried whole first (Svelte reads `lang="ts"` itself), then script-stripped. */
		keepScript?: boolean;
	} = {}
): string {
	// (the whole source first even when not preprocessed: stripping the script first made every
	// template with a `bind:` or a script name throw, and the dev router leg shipped 11 of the
	// profiler's 37 styled components unscoped)
	const inputs = opts.keepScript ? [source] : [source, source.replace(SCRIPT_TAG, '')];
	let err: unknown;
	for (const input of inputs) {
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
		} catch (e) {
			err ??= e;
		}
	}
	const why = (err as Error).message.split('\n')[0];
	if (opts.keepScript) {
		console.warn(
			`[ogygia] scoped CSS for ${abs} could not be compiled (${why}) — shipping its style bodies unscoped`
		);
	}
	const raw = extractRawStyleBodies(source);
	return raw ? unscoped_marker(abs, why) + raw : raw;
}

/** @param source */
export function svelteHasStyle(source: string): boolean {
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
/** A component's static imports: each specifier with the names it takes (`*` for a namespace;
 *  none for a bare `import 'x'`). Type-only imports are left out: they bring nothing at runtime. */
export function listStaticImports(
	source: string,
	filename: string
): Array<{ source: string; names: Set<string> }> {
	const out: Array<{ source: string; names: Set<string> }> = [];
	try {
		// (blanked styles: a raw SCSS `<style>` threw here and dropped to the regex fallback)
		const ast = parse(blank_styles(source), { filename, modern: true });
		const scripts = [ast.instance, ast.module].filter(Boolean);
		for (const block of scripts) {
			const content = block?.content;
			if (!content || content.type !== 'Program') continue;
			walk(content, {
				enter(node) {
					if (node.type !== 'ImportDeclaration') return;
					const decl = node as {
						source?: { value?: unknown };
						importKind?: string;
						specifiers?: Array<{
							type: string;
							importKind?: string;
							imported?: { name?: string; value?: string };
						}>;
					};
					const src = decl.source?.value;
					if (typeof src !== 'string' || decl.importKind === 'type') return;
					const names = new Set<string>();
					for (const s of decl.specifiers ?? []) {
						if (s.importKind === 'type') continue;
						if (s.type === 'ImportDefaultSpecifier') names.add('default');
						else if (s.type === 'ImportNamespaceSpecifier') names.add(ALL);
						else names.add(s.imported?.name ?? s.imported?.value ?? ALL);
					}
					out.push({ source: src, names });
				}
			});
		}
	} catch {
		for (const m of source.matchAll(IMPORT_SPEC)) out.push({ source: m[1], names: new Set([ALL]) });
	}
	return out;
}
