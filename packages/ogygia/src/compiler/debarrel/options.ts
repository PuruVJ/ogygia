/**
 * `ogygia({ barrels })` — what counts as a barrel, which importers get rewritten, what to keep.
 *
 * A BARREL is a module whose exports are re-exports of other modules: `index.ts` files, a package's
 * `components.ts`, `export * from` fan-outs. Importing one name from it drags the whole graph in: in
 * dev every module behind it is transformed and served, in build the chunk graph follows the import
 * graph before tree-shaking, and a package that is not `sideEffects: false` keeps all of it. The
 * debarrel pass replaces `import { A } from 'barrel'` with `import A from '<leaf of A>'` at
 * transform time, so the graph is the leaves the file actually uses.
 *
 * This pass is independent of islands: it does not read or write region marks. An import that
 * carries ogygia attributes (`with { wake }` …) is left exactly as written — a barrel binding is
 * marked through `asRegion` / a mark in the barrel, as before.
 */
export type Matcher = string | RegExp | ((id: string) => boolean);

export interface DebarrelOptions {
	/**
	 * DEPENDENCIES whose barrels may be bypassed too. The project's own modules need no listing:
	 * every file outside `node_modules` is a candidate, and purity decides (a barrel is PURE when
	 * every top-level statement is an import, a re-export, a type, or `export {}`). Packages are
	 * opt-in because Vite pre-bundles bare imports in dev: a leaf import that skips the optimizer
	 * while another importer gets the pre-bundled copy is two instances of one module. List a
	 * package here when you know it is safe (an ESM component library, excluded from
	 * `optimizeDeps`). Names, globs or regexes: `['@acme/ui', '@acme/*', /\/components\/index\.js$/]`.
	 * A plain string matches the specifier prefix (`'@acme/ui'` covers `@acme/ui/components`).
	 */
	packages?: Matcher[];
	/**
	 * Modules that are IMPURE barrels (own top-level code next to the re-exports) but should still
	 * be rewritten: the re-exported names go to their leaves, the barrel itself stays imported for
	 * its side effects (`import 'barrel'`). Without this, an impure barrel is left alone.
	 */
	force?: Matcher[];
	/** Never rewrite imports of these modules, whatever else says (a barrel whose own module-level
	 *  code the app depends on — a store singleton created in the barrel itself). */
	keep?: Matcher[];
	/** Which IMPORTERS are rewritten. Default: project files (not `node_modules`) with a JS / TS /
	 *  Svelte extension. */
	importers?: { include?: Matcher[]; exclude?: Matcher[] };
	/** Follow `export * from` into `node_modules` packages when building a barrel's export map
	 *  (default true). A star that reaches something unparsable (CJS, JSON) makes the barrel
	 *  OPAQUE for the names it cannot see: those stay on the barrel import. */
	followPackages?: boolean;
	/** A short report at the end of each build leg — files rewritten, imports and names moved, barrels
	 *  bypassed, time spent in the pass, the top barrels. Default true; `false` silences it. */
	report?: boolean;
	/** Log every rewrite as it happens (dev + build). */
	debug?: boolean;
}

export interface NormalizedOptions {
	packages: Matcher[];
	force: Matcher[];
	keep: Matcher[];
	importer_include: Matcher[];
	importer_exclude: Matcher[];
	follow_packages: boolean;
	report: boolean;
	debug: boolean;
}

export function normalize_options(o: DebarrelOptions | true = {}): NormalizedOptions {
	const opts = o === true ? {} : o;
	return {
		packages: opts.packages ?? [],
		force: opts.force ?? [],
		keep: opts.keep ?? [],
		importer_include: opts.importers?.include ?? [],
		importer_exclude: opts.importers?.exclude ?? [],
		follow_packages: opts.followPackages ?? true,
		report: opts.report !== false,
		debug: !!opts.debug
	};
}

const GLOB_STAR_G = /\*/g;
const REGEX_META_G = /[.+?^${}()|[\]\\]/g;

/** Does `m` match `id` (a resolved file id) or `spec` (the bare specifier as written)? */
export function matches(m: Matcher, id: string, spec: string): boolean {
	if (typeof m === 'function') return m(id) || m(spec);
	if (m instanceof RegExp) return m.test(id) || m.test(spec);
	if (m.includes('*')) {
		const re = new RegExp('^' + m.replace(REGEX_META_G, '\\$&').replace(GLOB_STAR_G, '.*') + '$');
		return re.test(spec) || re.test(id) || re.test(id.split('/node_modules/').pop() ?? id);
	}
	// a plain string: the specifier (or its package prefix), or a path segment of the resolved id
	return (
		spec === m ||
		spec.startsWith(m + '/') ||
		id.includes('/' + m + '/') ||
		id.endsWith('/' + m) ||
		id === m
	);
}

export function matches_any(ms: Matcher[], id: string, spec: string): boolean {
	for (const m of ms) if (matches(m, id, spec)) return true;
	return false;
}
