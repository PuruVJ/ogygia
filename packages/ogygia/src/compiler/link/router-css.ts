/**
 * `virtual:ogygia/router-css` — how a SERVER-ROUTER page's `<style>` reaches the document.
 *
 * THE GAP: Kit links a route's stylesheets from its file-derived route manifest. `ogygia/router`
 * routes are VALUES (`r.page(Home)`) rendered through `document()` — no route, so nothing ever
 * emitted or linked their CSS: a router page's scoped `<style>` (and its plain `.css` imports)
 * silently never loaded. (The playground's own rtr components are style-less for exactly this reason.)
 *
 * THE FIX, from existing primitives — no user file is modified, no `r.*` call-site analysis:
 *  1. CLOSURE (build data): a router MODULE is any module importing `'ogygia/router'` — wherever it
 *     lives, however many routers it defines, whatever function wraps them. Its transitive `.svelte`
 *     imports (followed through relative/$lib `.ts`/`.js` barrels — build-data resolution, not import
 *     rewriting) are the components any of its routers could render: the ROOTS.
 *  2. EMISSION (client leg, vite/index.ts): each root's whole transitive CSS (its own scoped styles +
 *     every child component's + plain `.css` imports, in cascade order) is compiled and emitted as ONE
 *     dedicated asset — resolved to a handoff `rcss:<rel>` href in writeBundle. A dedicated asset (not
 *     a chunk's `importedCss`) is immune to rolldown's shared-chunk CSS hoisting, which otherwise
 *     scatters a shared child's scoped CSS onto whatever chunk rolldown parks it on — an island's, off
 *     the router's static graph entirely (every profiler page shares Shell → this bites in practice).
 *  3. REGISTRATION (this virtual, SSR): imports each root by absolute path — the same module instance
 *     the router module holds, so identity survives barrels — and registers it in the runtime WeakMap
 *     with a thunk resolving its stylesheet entries (prod: handoff hrefs + `$app/paths` base; dev:
 *     inline CSS compiled here, Kit-style).
 *  4. LINKING (render): `render_page` looks up the components it actually renders, claims through
 *     `claim_region_css` (deduped with held-region links), and hands `document()` the head tags.
 */
import { fs, path } from '../host.js';
import {
	collectFoucCssReachable,
	compileFoucScopedCss,
	resolveFoucImportSpec
} from '../fouc-css.js';

const PATH_SEP = /[/\\]/;
const SVELTE_RE = /\.svelte$/;
const BARREL_RE = /\.(?:ts|js|mjs)$/;
/** Candidate suffixes for an extensionless spec, Vite resolution order-ish. */
const RESOLVE_SUFFIXES = ['', '.ts', '.js', '.mjs', '.svelte', '/index.ts', '/index.js'];

export const ROUTER_CSS_KEY_PREFIX = 'rcss:';

const posix = (p: string) => p.split(PATH_SEP).join('/');

/** The handoff css-map key for one root component (posix-rel to the app root). */
export function router_css_key(root: string, abs: string): string {
	return ROUTER_CSS_KEY_PREFIX + posix(path.relative(root, abs));
}

/**
 * The `.svelte` ROOTS of the app's router modules: BFS from every module that imports
 * `'ogygia/router'`, through relative/`$lib` `.ts`/`.js` re-exports (barrels — resolved as build
 * DATA, imports untouched), collecting `.svelte` leaves. `module_specs` is the prescan's import-spec
 * record (module abs path → its import/export-from specifiers). Sorted for determinism across legs.
 */
export function router_css_roots(
	router_modules: ReadonlySet<string>,
	module_specs: ReadonlyMap<string, readonly string[]>,
	lib_dir: string,
	exists: (p: string) => boolean = (p) => {
		try {
			return fs.statSync(p).isFile();
		} catch {
			return false;
		}
	}
): string[] {
	const roots = new Set<string>();
	const visited = new Set<string>();

	const resolve_spec = (spec: string, importer: string): string | null => {
		const base = resolveFoucImportSpec(spec.split('?')[0], importer, lib_dir);
		if (!base) return null; // package import — out of scope (library components use the app-side mark rules)
		for (const suffix of RESOLVE_SUFFIXES) {
			const candidate = path.normalize(base + suffix);
			if (exists(candidate)) return candidate;
		}
		return null;
	};

	const visit = (mod: string) => {
		if (visited.has(mod)) return;
		visited.add(mod);
		for (const spec of module_specs.get(mod) ?? []) {
			const resolved = resolve_spec(spec, mod);
			if (!resolved) continue;
			if (SVELTE_RE.test(resolved)) roots.add(resolved);
			else if (BARREL_RE.test(resolved)) visit(resolved);
		}
	};

	for (const mod of router_modules) visit(mod);
	return [...roots].sort();
}

/**
 * Emit the `virtual:ogygia/router-css` source. Empty (`export {}`) when the app has no router
 * modules — the router's dynamic import of this virtual then registers nothing, zero cost.
 */
export function router_css_module(
	roots: readonly string[],
	opts: {
		root: string;
		lib_dir: string;
		is_dev: boolean;
		read_file: (p: string) => string | null;
	}
): string {
	if (roots.length === 0) return 'export {};\n';

	const lines: string[] = [`import { register_router_css } from 'ogygia/internal/register';`];

	if (opts.is_dev) {
		// DEV: no built assets — inline the compiled CSS (what Kit does in dev). Compiled here at
		// module-emit time; the plugin invalidates this virtual on css/svelte hot updates.
		for (let i = 0; i < roots.length; i++) {
			const abs = roots[i];
			const rel = posix(path.relative(opts.root, abs));
			const entries: Array<{ key: string; css: string }> = [];
			for (const e of collectFoucCssReachable(abs, {
				root: opts.root,
				libDir: opts.lib_dir,
				readFile: opts.read_file
			})) {
				const e_rel = posix(path.relative(opts.root, e.abs));
				if (e.kind === 'scoped') {
					const source = opts.read_file(e.abs);
					if (source == null) continue;
					const css = compileFoucScopedCss(e.abs, source);
					if (css) entries.push({ key: `rcss-dev:${e_rel}`, css });
				} else {
					// Plain stylesheet import: raw file text. Preprocessor dialects (.scss/…) can't be
					// compiled here — skipped in dev inline (they load normally once built).
					if (!/\.css$/.test(e.abs)) continue;
					const css = opts.read_file(e.abs);
					if (css) entries.push({ key: `rcss-dev:${e_rel}`, css });
				}
			}
			lines.push(`import __OgRcss${i} from ${JSON.stringify(abs)};`);
			lines.push(`register_router_css(__OgRcss${i}, () => ${JSON.stringify(entries)});`);
		}
		return lines.join('\n') + '\n';
	}

	// PROD: hrefs resolve lazily from the island-deps handoff (written by the client leg, read at
	// render — Kit is SSR-first, so resolution must not happen at module init). `$app/paths` base is
	// applied HERE, in generated code: the handoff stores base-less hrefs and this virtual only ever
	// runs under the app's bundle where `$app/paths` resolves. The raw handoff href is the claim key,
	// so a held region linking the same sheet dedupes against us.
	lines.push(`import { islandCss } from 'virtual:ogygia/island-deps';`);
	lines.push(`import { base } from '$app/paths';`);
	for (let i = 0; i < roots.length; i++) {
		const abs = roots[i];
		const key = router_css_key(opts.root, abs);
		lines.push(`import __OgRcss${i} from ${JSON.stringify(abs)};`);
		lines.push(
			`register_router_css(__OgRcss${i}, () => islandCss(${JSON.stringify(key)}).map((h) => ({ key: h, href: base + h })));`
		);
	}
	return lines.join('\n') + '\n';
}
