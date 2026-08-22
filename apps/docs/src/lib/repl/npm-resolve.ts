/**
 * npm package resolution for the Observatory REPL — the PURE half (no network). Given a package.json
 * and a specifier, work out which file to load, the same way a bundler's node-resolution does:
 * `exports` (with conditions + subpaths + wildcards) → `browser` (string or map) → `module` → `main` →
 * `index`. We deliberately DON'T use jsdelivr's `/+esm` (it re-bundles shared deps like the svelte
 * runtime, mangling identity); we fetch RAW files and let rolldown do CJS→ESM / JSON, with svelte kept
 * external. The rolldown plugin ({@link ./cdn-plugin.ts}) wraps this with fetching + caching.
 */

/** A parsed bare specifier: `@scope/name@version/sub/path`. */
export interface ParsedSpecifier {
	/** Package name incl. scope, e.g. `lodash` or `@floating-ui/dom`. */
	name: string;
	/** Version / tag / range as written, or '' when unspecified (→ latest). */
	version: string;
	/** Subpath after the name, WITHOUT leading `./`, e.g. `debounce` or `dist/x.js`; '' for the root. */
	subpath: string;
}

// ── Regexes hoisted to module scope (compiled once, never re-created per call). ──
const RELATIVE_OR_ABSOLUTE = /^[./]/;
const URL_SCHEME = /^[a-z]+:/i;
const LEADING_DOTSLASH = /^\.\//;
const LEADING_SLASH = /^\//;
const TRAILING_SLASH = /\/$/;
const HAS_EXTENSION = /\.[a-z0-9]+$/i;
const STAR = /\*/g;

/** True for a bare import (an npm package), false for a relative/absolute path or a URL. */
export function is_bare(spec: string): boolean {
	return !RELATIVE_OR_ABSOLUTE.test(spec) && !URL_SCHEME.test(spec);
}

/**
 * Parse a bare specifier into name / version / subpath. Handles scopes (`@org/pkg`), embedded versions
 * (`pkg@1.2.3`, `@org/pkg@1.2.3`), and subpaths (`pkg/sub`, `@org/pkg@1/sub/deep`).
 */
export function parse_specifier(spec: string): ParsedSpecifier {
	let rest = spec;
	let name: string;
	if (rest[0] === '@') {
		// @scope/name — the name spans the FIRST two segments.
		const slash = rest.indexOf('/');
		const slash2 = rest.indexOf('/', slash + 1);
		const nameEnd = slash2 === -1 ? rest.length : slash2;
		name = rest.slice(0, nameEnd);
		rest = rest.slice(nameEnd); // '' or '/sub…'
	} else {
		const slash = rest.indexOf('/');
		name = slash === -1 ? rest : rest.slice(0, slash);
		rest = slash === -1 ? '' : rest.slice(slash);
	}
	// A version can ride on the name: `name@1.2.3` (the LAST '@' that isn't the scope's leading one).
	let version = '';
	const at = name.lastIndexOf('@');
	if (at > 0) {
		version = name.slice(at + 1);
		name = name.slice(0, at);
	}
	const subpath = rest.replace(LEADING_SLASH, '');
	return { name, version, subpath };
}

/**
 * Conditions we resolve for, most-specific first. `svelte` FIRST — a Svelte component lib exposes its
 * real entry under the `svelte` export condition (radix-svelte / bits-ui: `exports['.'] = { svelte,
 * types }`, no `import`/`default`), and that's the one a Svelte-aware bundler must pick. Then the usual
 * browser-ESM chain. (`module`/`main` fallbacks below cover packages with no `exports` at all.)
 */
export const BROWSER_CONDITIONS = ['svelte', 'browser', 'import', 'module', 'default'] as const;

type ExportsNode = string | string[] | { [k: string]: ExportsNode } | null;

/** Walk a conditions node (string | array | { condition: … }) picking the first matching condition. */
function resolve_conditions(node: ExportsNode, conditions: readonly string[]): string | null {
	if (node == null) return null;
	if (typeof node === 'string') return node;
	if (Array.isArray(node)) {
		for (const n of node) {
			const r = resolve_conditions(n, conditions);
			if (r) return r;
		}
		return null;
	}
	for (const cond of conditions) {
		if (cond in node) {
			const r = resolve_conditions(node[cond]!, conditions);
			if (r) return r;
		}
	}
	return null;
}

/**
 * Resolve a package `exports` field for `subpath` ('.' for the root, else './sub'). Handles the string
 * shorthand, a conditions object at the root, a subpath map, and `./*` wildcard patterns.
 */
export function resolve_exports(
	exports: ExportsNode,
	subpath: string,
	conditions: readonly string[] = BROWSER_CONDITIONS
): string | null {
	if (exports == null) return null;
	const key = subpath === '.' || subpath === '' ? '.' : './' + subpath.replace(LEADING_DOTSLASH, '');
	// String / array shorthand → the root target.
	if (typeof exports === 'string' || Array.isArray(exports)) {
		return key === '.' ? resolve_conditions(exports, conditions) : null;
	}
	const keys = Object.keys(exports);
	const is_subpath_map = keys.some((k) => k === '.' || k.startsWith('./'));
	if (!is_subpath_map) {
		// A bare conditions object → only valid for the root.
		return key === '.' ? resolve_conditions(exports as ExportsNode, conditions) : null;
	}
	// Exact subpath.
	if (exports[key] !== undefined) return resolve_conditions(exports[key]!, conditions);
	// Wildcard patterns (`./*`, `./dist/*.js`). Longest matching prefix wins.
	let best: { target: string; star: string } | null = null;
	let best_len = -1;
	for (const k of keys) {
		const star = k.indexOf('*');
		if (star === -1) continue;
		const pre = k.slice(0, star);
		const post = k.slice(star + 1);
		if (key.length >= pre.length + post.length && key.startsWith(pre) && key.endsWith(post)) {
			const matched = key.slice(pre.length, key.length - post.length);
			const target = resolve_conditions(exports[k]!, conditions);
			if (target && pre.length > best_len) {
				best = { target, star: matched };
				best_len = pre.length;
			}
		}
	}
	if (best) return best.target.replace(STAR, best.star);
	return null;
}

/** The `browser` field: a string replaces the main entry; an object remaps/stubs specific files. */
export type BrowserField = string | Record<string, string | false> | undefined;

/**
 * Apply the `browser` MAP to a resolved relative file (`./server.js` → `./browser.js`, or `false` →
 * a stub sentinel). `file` is package-relative (leading `./`). Returns the remapped target, the
 * {@link BROWSER_STUB} sentinel when mapped to `false`, or the input unchanged.
 */
export const BROWSER_STUB = '\0repl-browser-stub';
export function apply_browser_map(browser: BrowserField, file: string): string {
	if (!browser || typeof browser === 'string') return file;
	const norm = file.replace(LEADING_DOTSLASH, '');
	for (const [from, to] of Object.entries(browser)) {
		const f = from.replace(LEADING_DOTSLASH, '');
		if (f === norm || f === file || './' + f === file) {
			return to === false ? BROWSER_STUB : to;
		}
	}
	return file;
}

/**
 * Resolve the ENTRY file (a package-relative path like `./dist/x.mjs`) for a package + subpath, given
 * its package.json. Order: `exports` → `browser`(string) → `module` → `browser`-remapped `main` →
 * `main` → `index.js`. For an explicit subpath with no `exports`, the literal file is used (extension
 * resolution happens at fetch time).
 */
export function resolve_entry(
	pkg: Record<string, unknown>,
	subpath: string,
	conditions: readonly string[] = BROWSER_CONDITIONS
): string {
	const has_sub = subpath !== '' && subpath !== '.';
	if (pkg.exports != null) {
		const r = resolve_exports(pkg.exports as ExportsNode, has_sub ? subpath : '.', conditions);
		if (r) return r.replace(LEADING_DOTSLASH, '');
		// `exports` present but no match for the subpath — fall through to the literal file (some
		// packages ship files outside their exports map).
	}
	if (has_sub) {
		return apply_browser_map(pkg.browser as BrowserField, './' + subpath).replace(LEADING_DOTSLASH, '');
	}
	// The top-level `svelte` field — the canonical entry for a Svelte component lib with no `exports`
	// map (older bits-ui / most svelte-package libs). Preferred over module/main for the REPL.
	const svelte_field = pkg.svelte as string | undefined;
	if (svelte_field) return svelte_field.replace(LEADING_DOTSLASH, '');
	const browser = pkg.browser as BrowserField;
	if (typeof browser === 'string') return browser.replace(LEADING_DOTSLASH, '');
	const module_field = pkg.module as string | undefined;
	if (module_field) return apply_browser_map(browser, module_field).replace(LEADING_DOTSLASH, '') || module_field.replace(LEADING_DOTSLASH, '');
	const main = (pkg.main as string | undefined) || 'index.js';
	const mapped = apply_browser_map(browser, main.startsWith('./') ? main : './' + main);
	return mapped.replace(LEADING_DOTSLASH, '');
}

/**
 * Candidate files for a relative import with no/ambiguous extension, in node's try-order:
 * the literal, then `.mjs`/`.js`/`.cjs`/`.json`, then `/index.*`. The plugin fetches these in order.
 */
export function extension_candidates(path: string): string[] {
	const has_ext = HAS_EXTENSION.test(path.split('/').pop() || '');
	const out: string[] = [path];
	// A specifier WITH an extension is taken as a file; only extension-less ones try `.js`/`index.*`
	// (they might name a file OR a directory).
	if (!has_ext) {
		for (const ext of ['.mjs', '.js', '.cjs', '.json']) out.push(path + ext);
		for (const ext of ['.mjs', '.js', '.cjs', '.json'])
			out.push(path.replace(TRAILING_SLASH, '') + '/index' + ext);
	}
	return [...new Set(out)];
}
