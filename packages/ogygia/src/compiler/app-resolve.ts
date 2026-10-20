/**
 * APP RESOLUTION — the ONE place the compiler's sync graph walks (the island closure, CSS
 * reachability, router CSS roots, the bake) answer "which file does this import name?". Nothing else
 * in the compiler inspects a specifier's shape: a walk hands its `(spec, importer)` here and gets a
 * file, or null for a package (out of scope for a walk; the bundler resolves it).
 *
 * It decides nothing of its own — it applies, in Vite's order, the rules the app already declared
 * to its bundler, so a walk reaches exactly the files the build will:
 * 1. relative / absolute paths;
 * 2. the app's aliases — Vite's resolved `resolve.alias` list, which already carries Kit's `alias`
 *    and anything an alias plugin put there;
 * 3. `#…` subpath imports — the `"imports"` map of the importer's nearest package.json (Kit's `#lib`
 *    is one entry; an app or a workspace package may declare any others), Node's rules;
 * then, for a path without a file behind it, Vite's extension probing (`resolve.extensions`, the
 * `.js` → `.ts` swap, `/index.*`).
 */
import { fs, path } from './host.js';

/** One resolved Vite alias (`config.resolve.alias`, normalized to an array). */
export interface AppAlias {
	find: string | RegExp;
	replacement: string;
}

/** Vite's default `resolve.extensions`, plus Svelte's (`.svelte`; `x.svelte.ts` is `x.svelte` + `.ts`). */
export const APP_EXTENSIONS: readonly string[] = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json', '.svelte'];

/** A JS extension a TypeScript source writes for its sibling `.ts` (Vite's swap). */
const TS_TWIN: Readonly<Record<string, readonly string[]>> = {
	'.js': ['.ts', '.tsx'],
	'.mjs': ['.mts'],
	'.jsx': ['.tsx']
};

/**
 * Where `spec`, imported from `importer` (an absolute file path), points — a path that may still
 * need its extension — or null for a package specifier.
 */
export function app_spec_path(spec: string, importer: string, alias: readonly AppAlias[] = []): string | null {
	if (spec.startsWith('.')) return path.resolve(path.dirname(importer), spec);
	if (path.isAbsolute(spec)) return spec;
	for (const a of alias) {
		if (typeof a.find === 'string') {
			if (spec === a.find) return a.replacement;
			if (spec.startsWith(a.find + '/')) return a.replacement + spec.slice(a.find.length);
		} else if (a.find.test(spec)) {
			return spec.replace(a.find, a.replacement);
		}
	}
	if (spec.startsWith('#')) return subpath_import(spec, importer);
	return null;
}

export interface ProbeOptions {
	/** the app's aliases (Vite's resolved `resolve.alias`) */
	alias?: readonly AppAlias[];
	/** the extensions to try (Vite's `resolve.extensions`); {@link APP_EXTENSIONS} by default */
	extensions?: readonly string[];
	/** whether a path is a file — the real filesystem by default (a test passes a virtual one) */
	is_file?: (p: string) => boolean;
}

/** The FILE `spec` imports from `importer` (probed), or null for a package or a missing file. */
export function app_file(spec: string, importer: string, opts: ProbeOptions = {}): string | null {
	const base = app_spec_path(spec, importer, opts.alias);
	return base === null ? null : probe_file(base, opts);
}

function fs_is_file(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

/** `base` as an existing file: itself, `+ext`, its `.ts` twin, or `/index+ext`; null when none. */
export function probe_file(base: string, opts: ProbeOptions = {}): string | null {
	const extensions = opts.extensions ?? APP_EXTENSIONS;
	const is_file = opts.is_file ?? fs_is_file;
	base = path.normalize(base);
	if (is_file(base)) return base;
	for (const ext of extensions) if (is_file(base + ext)) return base + ext;
	const dot = base.lastIndexOf('.');
	const twins = dot > base.lastIndexOf('/') ? TS_TWIN[base.slice(dot)] : undefined;
	if (twins) for (const t of twins) if (is_file(base.slice(0, dot) + t)) return base.slice(0, dot) + t;
	for (const ext of extensions) if (is_file(base + '/index' + ext)) return base + '/index' + ext;
	return null;
}

// ── subpath imports (`#…`): the importer's package scope, read once per directory ─────────────

type Target = string | null | Target[] | { [condition: string]: Target };
interface Scope {
	dir: string;
	imports: Record<string, Target> | null;
}

/** The conditions a server-side source walk honours, in no order (the target object's order rules). */
const CONDITIONS = new Set(['svelte', 'import', 'module', 'node', 'development', 'default']);

/** directory → its package scope (`null`: no package.json up to the root) */
const scope_of_dir = new Map<string, Scope | null>();

function find_scope(dir: string): Scope | null {
	const hit = scope_of_dir.get(dir);
	if (hit !== undefined) return hit;
	let scope: Scope | null;
	const pkg = path.join(dir, 'package.json');
	if (fs.existsSync(pkg)) {
		let imports: Record<string, Target> | null = null;
		try {
			const json = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { imports?: unknown };
			if (json.imports && typeof json.imports === 'object') imports = json.imports as Record<string, Target>;
		} catch {
			/* an unreadable package.json declares nothing */
		}
		scope = { dir, imports };
	} else {
		const parent = path.dirname(dir);
		scope = parent === dir ? null : find_scope(parent);
	}
	scope_of_dir.set(dir, scope);
	return scope;
}

/** A target: a `./` path inside the package, a conditions object (first supported condition in its
 *  own order), or an array (first that resolves); `null` excludes; a bare package is not app source. */
function pick(target: Target, star: string | null): string | null {
	if (target === null) return null;
	if (typeof target === 'string') {
		if (!target.startsWith('./')) return null;
		return star === null ? target : target.split('*').join(star);
	}
	if (Array.isArray(target)) {
		for (const t of target) {
			const r = pick(t, star);
			if (r !== null) return r;
		}
		return null;
	}
	for (const key in target) if (CONDITIONS.has(key)) return pick(target[key], star);
	return null;
}

/** An exact key wins; else the `*` key with the longest prefix that fits, its match put in the target. */
function subpath_import(spec: string, importer: string): string | null {
	const scope = find_scope(path.dirname(importer));
	const imports = scope?.imports;
	if (!scope || !imports) return null;
	let rel: string | null = null;
	if (Object.hasOwn(imports, spec)) {
		rel = pick(imports[spec], null);
	} else {
		let best = '';
		for (const key in imports) {
			const star = key.indexOf('*');
			if (star === -1 || key.indexOf('*', star + 1) !== -1) continue;
			const prefix = key.slice(0, star);
			const suffix = key.slice(star + 1);
			if (prefix.length > best.length && spec.length >= key.length - 1 && spec.startsWith(prefix) && spec.endsWith(suffix)) {
				best = prefix;
				rel = pick(imports[key], spec.slice(prefix.length, spec.length - suffix.length));
			}
		}
	}
	return rel === null ? null : path.join(scope.dir, rel);
}

/** Forget every package scope read (a package.json changed while the dev server runs). */
export function clear_app_resolve_cache(): void {
	scope_of_dir.clear();
}
