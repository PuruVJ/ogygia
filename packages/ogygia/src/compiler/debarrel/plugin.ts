/**
 * The debarrel Vite plugin — barrel imports become leaf imports at transform time.
 *
 *   import { Button, Card } from '$lib/components';        // an index.ts that re-exports 40 files
 *   → import Button from '/…/components/Button.svelte';
 *     import Card from '/…/components/Card.svelte';
 *
 * Why a plugin and not tree-shaking: dev never tree-shakes (every module behind the barrel is
 * transformed and served); build only drops what `sideEffects: false` allows, and a package that
 * registers components or creates stores is not that; the chunk graph follows the import graph
 * before shaking.
 *
 * Two ways in, one code path: `ogygia({ barrels })` folds it into the ogygia plugin array (first,
 * so the region transform sees leaf imports) and tells it to leave region-marked imports alone;
 * `debarrel()` from `ogygia/vite` is the same plugin for any Vite app, marks or not.
 *
 * Runs `enforce: 'pre'`. Uses the compiler's parser for modules, the Svelte parser for `.svelte`
 * script blocks, `this.resolve` for resolution (aliases, `exports` maps, extensions — whatever the
 * app's Vite knows), and `this.addWatchFile` so an edit to a barrel re-transforms the importers
 * that no longer import it.
 */
import { readFileSync, statSync } from 'node:fs';
import { searchForWorkspaceRoot, type Plugin } from 'vite';
import { BarrelIndex, type ExportMap, type Host } from './barrel.js';
import { matches_any, normalize_options, type DebarrelOptions } from './options.js';
import { rewrite_module, type RewritePolicy } from './rewrite.js';
import { rewrite_svelte } from './svelte.js';

const IMPORTER_RE = /\.(?:[cm]?[jt]sx?|svelte|svelte\.[jt]s)$/;
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/;
const QUERY_RE = /[?#].*$/;
const BACKSLASH_G = /\\/g;

/** The slice of the plugin context the index needs — what `buildStart` / `transform` hand us. */
interface Resolver {
	resolve(
		source: string,
		importer?: string,
		options?: { skipSelf?: boolean }
	): Promise<{ id: string; external?: boolean | string } | null>;
}

export interface DebarrelInternal {
	/** Import-attribute keys that mark an import as ogygia's: such an import is never rewritten. */
	skip_attribute_keys?: string[];
	/** Local bindings of a file that carry an island identity without an attribute (ogygia:
	 *  `import.meta.og.asRegion(X)`): a declaration binding one of them is never rewritten, so
	 *  the id the compiler's prescan derives from the raw source is the id the transform sees. */
	skip_locals?: (code: string) => ReadonlySet<string>;
}

export function debarrel(options: DebarrelOptions | true = {}, internal: DebarrelInternal = {}): Plugin {
	const o = normalize_options(options);
	const skip_keys = new Set(internal.skip_attribute_keys ?? []);
	const policy_for = (code: string): RewritePolicy => {
		const locals = internal.skip_locals?.(code);
		return {
			skip: (decl) =>
				decl.attribute_keys.some((k) => skip_keys.has(k)) ||
				(!!locals && locals.size > 0 && decl.specs.some((s) => locals.has(s.local)))
		};
	};
	let root = process.cwd().replace(BACKSLASH_G, '/');
	let resolver: Resolver | null = null;
	let log: (msg: string) => void = (msg) => console.log(msg);
	let command: 'build' | 'serve' = 'serve';
	const mtimes = new Map<string, number>();
	// The report: what the pass did in this build leg (reset after each print — Kit runs several).
	const fresh_report = () => ({
		files: 0,
		importers: 0,
		imports: 0,
		names: 0,
		// wall-clock span from the first transform to the last — transforms overlap, so a sum of
		// per-file durations would count the same waiting many times over
		first_ms: 0,
		last_ms: 0,
		barrels: new Map<string, { names: number; importers: Set<string> }>()
	});
	let report = fresh_report();

	// One index per plugin instance. Resolution goes through Vite via whichever plugin context last
	// handed us its `resolve` — `buildStart` first, then every `transform` (any context resolves the
	// same; `skipSelf` keeps us out of our own hook). Reads are the file system with an mtime check:
	// a changed barrel drops its cached shape and every map that depended on it.
	const host: Host = {
		read(id) {
			try {
				const st = statSync(id);
				const prev = mtimes.get(id);
				if (prev !== undefined && prev !== st.mtimeMs) index.invalidate(id);
				mtimes.set(id, st.mtimeMs);
				return readFileSync(id, 'utf8');
			} catch {
				return null;
			}
		},
		async resolve(spec, importer) {
			if (!resolver) return null;
			// Vite THROWS for a specifier it cannot resolve from this importer (a strict pnpm layout, a
			// deep import into a package's `src`). Unresolvable = not a barrel: the import stays as
			// written and the bundler reports it — or not, if the import was a type.
			let r: Awaited<ReturnType<Resolver['resolve']>>;
			try {
				r = await resolver.resolve(spec, importer, { skipSelf: true });
			} catch {
				return null;
			}
			if (!r || r.external) return null;
			return r.id.replace(BACKSLASH_G, '/');
		},
		candidate(id, spec) {
			if (o.packages.length && matches_any(o.packages, id, spec)) return true;
			if (o.force.length && matches_any(o.force, id, spec)) return true;
			// default: any project module that is not a dependency — purity decides the rest
			return !NODE_MODULES_RE.test(id) && id.startsWith(root + '/');
		},
		forced: (id, spec) => o.force.length > 0 && matches_any(o.force, id, spec),
		kept: (id, spec) => o.keep.length > 0 && matches_any(o.keep, id, spec),
		follow_packages: o.follow_packages
	};
	const index = new BarrelIndex(host);

	const is_importer = (id: string): boolean => {
		if (id.includes('\0')) return false;
		const clean = id.replace(QUERY_RE, '');
		if (!IMPORTER_RE.test(clean)) return false;
		if (o.importer_include.length) return matches_any(o.importer_include, clean, clean);
		if (NODE_MODULES_RE.test(clean)) return false;
		if (o.importer_exclude.length && matches_any(o.importer_exclude, clean, clean)) return false;
		return true;
	};

	return {
		name: 'ogygia:debarrel',
		enforce: 'pre',
		configResolved(config) {
			// The PROJECT is the workspace, not the app: in a monorepo the barrels that matter live in
			// sibling packages (`../../packages/core/stores.ts`), outside the Vite root.
			root = searchForWorkspaceRoot(config.root).replace(BACKSLASH_G, '/');
			command = config.command;
			log = (msg) => config.logger.info(msg);
		},
		buildStart() {
			resolver = this as unknown as Resolver;
		},
		async transform(code, id) {
			if (!is_importer(id)) return null;
			resolver = this as unknown as Resolver;
			const t0 = performance.now();
			if (report.files === 0) report.first_ms = t0;
			report.files++;
			const importer = id.replace(QUERY_RE, '');
			const seen: ExportMap[] = [];
			const lookup = async (spec: string): Promise<ExportMap | null> => {
				const resolved = await host.resolve(spec, importer);
				if (!resolved) return null;
				const map = await index.map(resolved, spec);
				if (map) seen.push(map);
				return map;
			};
			const policy = policy_for(code);
			const result = importer.endsWith('.svelte')
				? await rewrite_svelte(code, importer, lookup, policy)
				: await rewrite_module(code, importer, lookup, policy);
			// The importer no longer imports the barrels it was rewritten away from: watch them (and
			// what their maps depend on) so an edit still re-transforms this file in dev.
			for (const map of seen) for (const d of map.deps) this.addWatchFile(d);
			report.last_ms = performance.now();
			if (!result) return null;
			report.importers++;
			report.imports += result.moves.length;
			for (const m of result.moves) {
				report.names += m.names.length;
				const b = report.barrels.get(m.barrel) ?? { names: 0, importers: new Set<string>() };
				b.names += m.names.length;
				b.importers.add(importer);
				report.barrels.set(m.barrel, b);
			}
			if (o.debug)
				for (const m of result.moves)
					log(
						`[ogygia] barrels: ${short(importer, root)}: ${m.names.join(', ')} ← ${short(m.barrel, root)} → ${m.leaves.map((l) => short(l, root)).join(', ')}`
					);
			return { code: result.code, map: result.map };
		},
		watchChange(id) {
			index.invalidate(id.replace(BACKSLASH_G, '/'));
		},
		// The report, once per build leg (Kit builds client then server; each gets its own). Dev
		// prints nothing here — `debug` narrates rewrites as they happen.
		closeBundle() {
			if (o.report && command === 'build') log(format_report(report, root, o.report === 'all' ? Infinity : 8));
			report = fresh_report();
		}
	};
}

function short(id: string, root: string): string {
	return id.startsWith(root + '/') ? id.slice(root.length + 1) : id;
}

const n = (v: number) => v.toLocaleString('en-US');

/** The build-time report: totals, time spent in the pass, and the barrels by names moved — the
 *  `limit` biggest and a count of the rest (`Infinity` for every one). */
export function format_report(r: ReturnType<typeof debarrel_report_shape>, root: string, limit: number): string {
	const span_s = ((r.last_ms - r.first_ms) / 1000).toFixed(2);
	if (r.importers === 0)
		return `[ogygia] barrels: ${n(r.files)} files scanned, no barrel imports to rewrite (${span_s} s)`;
	const head =
		`[ogygia] barrels: ${n(r.importers)} of ${n(r.files)} files rewritten — ${n(r.imports)} barrel imports → leaves ` +
		`(${n(r.names)} names), ${n(r.barrels.size)} barrels bypassed, ${span_s} s first to last transform`;
	const sorted = [...r.barrels.entries()].sort((a, b) => b[1].names - a[1].names);
	const top = sorted.slice(0, limit);
	const width = Math.max(...top.map(([, b]) => n(b.names).length));
	const rows = top.map(
		([id, b]) =>
			`  ${n(b.names).padStart(width)} names  ${short(id, root)}  ← ${n(b.importers.size)} importer${b.importers.size === 1 ? '' : 's'}`
	);
	const rest = sorted.length - top.length;
	if (rest > 0) rows.push(`  … and ${n(rest)} more barrel${rest === 1 ? '' : 's'} (\`barrels: { report: 'all' }\` lists every one)`);
	return [head, ...rows].join('\n');
}

/** The report record's shape (for `format_report`'s signature — the value lives in the closure). */
function debarrel_report_shape() {
	return {
		files: 0,
		importers: 0,
		imports: 0,
		names: 0,
		first_ms: 0,
		last_ms: 0,
		barrels: new Map<string, { names: number; importers: Set<string> }>()
	};
}
