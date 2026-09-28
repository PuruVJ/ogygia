/**
 * THE LINE LEDGER — the exact lines of the app's code that cost the most, with every cost the
 * profiler measured joined on the one line: CPU self time (V8's per-line ticks), bytes allocated
 * and the GC time they caused (the allocation profile, a builtin charged to the app line that
 * called it), and bytes still alive after a collection (the retention pass). Three sections of
 * the report each hold one of these, keyed by function; this puts them on the line a person
 * edits, next to the code itself.
 *
 * Only the app's own lines (app code and components): a line inside a dependency is not one the
 * reader can change — a dependency's cost reaches the ledger through the app line that allocated
 * it, and its CPU through "paths to fix" (a CPU profile records where a function starts, never
 * the line that called it, so there is no call-site line to charge dependency CPU to).
 *
 * Pure: the host hands in the analysed functions, the GC makers and retained sites (each carrying
 * `at`, the app line it is charged to) and a reader for a source line.
 */
import type { FrameStat, FrameCategory } from './analyze.js';
import type { GcMaker } from './gc.js';
import type { RetainedSite } from './insights.js';
import { calls_name, function_body, import_aliases, REGEXP_FRAME, tokens } from './source-scan.js';
import { app_relative } from './app-path.js';

export interface LedgerLine {
	/** the resolved source path (the join key, with `line`) */
	path: string;
	/** a short display path */
	file: string;
	line: number;
	/** a line of a BUILT chunk (no sourcemap): the source module whose code it is, from the build's
	 *  module map (`src/lib/format.ts`) — the line number stays the chunk's */
	module?: string;
	/** the code on that line, when the source was available */
	code?: string;
	/** CPU self time that landed on this line, ms */
	cpu_ms: number;
	/** bytes allocated by this line (or by builtins it called) */
	alloc_bytes: number;
	/** GC pause time those allocations caused, ms */
	gc_ms: number;
	/** bytes still alive after one more render and a full collection */
	retained_bytes: number;
	/** the functions and builtins whose cost landed here (`formatPrice`, `replace`), heaviest first */
	who: string[];
	/** the key of the function whose CPU landed here most (its row in the functions table) */
	fn?: string;
	/** the memory numbers are the whole function's, folded onto its hottest line: an allocation
	 *  profile sees the function an allocation happened in, never the line */
	mem_in_fn?: boolean;
	/** some of the memory numbers were made INSIDE this package, which the line calls, with no app
	 *  frame above them (the library's work after an await): charged here, the way its CPU is */
	mem_via?: string;
	/** the growth check's verdict on what this line kept: still growing render after render
	 *  (`true`), or flat after the first (`false`, a bounded cache); absent when it did not run */
	grows?: boolean;
	/** CPU spent inside libraries (dependencies, Node) that THIS line called, ms: a CPU profile
	 *  never records a call site, so it is found by reading the calling function's source for the
	 *  library function's name (or its import alias) — split evenly when it is called on several */
	lib_ms: number;
	/** those library calls, heaviest first */
	libs?: LibCall[];
	/** the line's combined share of every cost in the ledger (0..3): how it ranks */
	score: number;
	/** its CPU was moved here from line `from`: V8 had inlined `callee` and charged its time there
	 *  (split by the un-inlined render's times) */
	merged?: { from: number; callee: string };
}

export interface LibCall {
	/** the library function's own name (`renderToString`) */
	name: string;
	/** its package (`@acme/ui`), `Node` for Node's own, '' when unknown */
	pkg: string;
	ms: number;
	/** the call appears on this many lines of the caller, and `ms` is this line's even share */
	shared?: number;
}

export interface LedgerInput {
	functions: readonly FrameStat[];
	makers?: readonly GcMaker[];
	retained?: readonly RetainedSite[];
	/** the growth check: what each site still held after `renders` more renders */
	grown?: {
		renders: number;
		sites: readonly RetainedSite[];
		half?: { renders: number; sites: readonly RetainedSite[] };
	};
	/** the code on a source line (untrimmed is fine), or undefined */
	code?: (path: string, line: number) => string | undefined;
	/** lines `from`..`to` of a source (1-based, inclusive): what finds library call sites */
	source?: (
		path: string,
		from: number,
		to: number
	) => { start: number; lines: string[] } | undefined;
	/** the app functions of a render profiled with V8's inlining OFF (the call-count render): each
	 *  keeps its own frame there, so its time says whose share a merged caller line holds */
	uninlined?: readonly (Pick<FrameStat, 'name' | 'path' | 'category' | 'total_ms' | 'lines'> &
		Partial<Pick<FrameStat, 'key' | 'line' | 'url' | 'callees'>>)[];
	/** the renders `functions` add up (page mode's runs); `uninlined` is one render */
	renders?: number;
	limit?: number;
}

/** the package of a `node_modules`-relative path: `@acme/ui/hydrate/x.mjs:1` → `@acme/ui` */
export function pkg_of(file: string): string {
	const parts = file.split('/');
	if (!parts[0] || !file.includes('/')) return '';
	return parts[0].startsWith('@') && parts[1] ? parts[0] + '/' + parts[1] : parts[0];
}

/** the framework the app runs on: SvelteKit, Svelte, ogygia itself, Vite */
export const is_framework_pkg = (p: string) =>
	p.startsWith('@sveltejs/') || p === 'svelte' || p.startsWith('ogygia') || p === 'vite';

/** After `renders` more renders a leaking line holds about `renders` × what one render left; one
 *  filling a bounded cache holds its capacity's worth. At 80 % of `renders`× or more it grew with
 *  EVERY render measured. The limit, said plainly: a cache holding at least `renders` entries is
 *  indistinguishable from a leak in that many renders. */
export const grows_of = (grown: number, one: number, renders: number): boolean | undefined => {
	// under 5 renders a small bounded cache (4 entries) is a leak's twin: no verdict rather than a wrong one
	if (renders < GROWS_MIN_RENDERS || !(one > 0)) return undefined;
	// the heap sample is statistical (a quarter either way at a megabyte a render), so the middle
	// band is no verdict: a 4-entry cache over 6 renders (0.67) must never read as a leak
	const ratio = grown / (one * renders);
	return ratio >= 0.85 ? (renders >= LEAK_MIN_RENDERS ? true : undefined) : ratio <= 0.5 ? false : undefined;
};
const GROWS_MIN_RENDERS = 5;
/** A LEAK verdict needs 6 renders. The check is cut short on a tight time budget, and over 5 a
 *  cache that keeps 4 entries holds 4 of the 5 renders' worth: a leak's shape, told apart only by
 *  sampling noise (the slow-patterns key's bounded-cache decoy read "grows" in 1 run of 3).
 *  "Levels off" still reads from 5: a leak never looks flat. */
const LEAK_MIN_RENDERS = 6;

/** The steadier verdict: the same sampler read after `h` renders (`half`) and after `n` (`full`).
 *  A leaking line holds `n/h` times as much at the end as halfway; one feeding a bounded cache
 *  that filled holds about the same. The sampled objects are the same objects in both reads, so
 *  one sample's noise cancels; the middle band is still no verdict. */
export const grows_between = (
	half: number,
	full: number,
	h: number,
	n: number
): boolean | undefined => {
	if (n < GROWS_MIN_RENDERS || h < 1 || h >= n) return undefined;
	// nothing sampled halfway is no evidence of growth: the sampler can miss a line in one read
	if (!(half > 0)) return undefined;
	const expected = n / h; // a leak's ratio (2 for 3 of 6)
	const ratio = full / half;
	if (ratio >= 1 + 0.85 * (expected - 1)) return n >= LEAK_MIN_RENDERS ? true : undefined;
	if (ratio <= 1 + 0.5 * (expected - 1)) return false;
	return undefined;
};

/** "grows" from the halfway read, CHECKED against the one-render amount: a leak holds about one
 *  render's worth per render (all `renders` of them), a cache with a size limit holds its capacity.
 *  The two sampled reads can land far enough apart by chance to read as growth (a 4-entry cache,
 *  sampled low halfway and high at the end); a line holding well under the renders' worth is not
 *  leaking — no verdict then. Stays "grows" when the one-render amount is unknown.
 *  One render's worth is the LARGER of two estimates: the separate one-render pass, and the
 *  halfway read over its renders (the same sampler as the end read, so their noise is shared).
 *  A low draw on one of them no longer makes a filled cache look like a leak. */
export const confirmed = (
	between: boolean | undefined,
	grown: number,
	one: number,
	renders: number,
	half?: { bytes: number; renders: number }
): boolean | undefined => {
	if (between !== true || !(one > 0) || renders <= 0) return between;
	const per = Math.max(one, half && half.renders > 0 ? half.bytes / half.renders : 0);
	return grown / (per * renders) >= 0.75 ? true : undefined;
};

/** a callee a line can be charged for: library code, never Svelte's markup internals or V8's own */
const LIB: ReadonlySet<FrameCategory> = new Set<FrameCategory>(['dependency', 'node']);

const APP: ReadonlySet<FrameCategory> = new Set<FrameCategory>(['app', 'component']);

/** words before a `(` that are not calls */
const CONTROL: ReadonlySet<string> = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function']);
const ID_START = (s: string) => {
	const c = s.charCodeAt(0);
	return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
};
/** the calls that run a regular expression */
const REGEXP_METHODS = ['test', 'exec', 'match', 'matchAll', 'replace', 'replaceAll', 'split', 'search'];

/** A readable path: from `src/` when the path has one, the package-relative path inside
 *  `node_modules`, else the last three segments. */
export function short_source(path: string): string {
	const p = path.startsWith('file://') ? path.slice(7) : path;
	const nm = p.lastIndexOf('/node_modules/');
	if (nm !== -1) return p.slice(nm + 14);
	const own = app_relative(p);
	if (own !== undefined) return own;
	const src = p.lastIndexOf('/src/');
	if (src !== -1) return p.slice(src + 1);
	const parts = p.split('/');
	return parts.length > 3 ? parts.slice(-3).join('/') : p;
}

/** a source path the reader could open and edit: not a dependency, not Node's own, not the
 *  framework's generated build output (a compiled route chunk nobody edits), and not ogygia's own
 *  source reached through a workspace link (`packages/ogygia/src/…`: no node_modules segment, but
 *  the library all the same, as analyze's categorize already says) */
export const is_app_path = (path: string) =>
	!!path &&
	!path.includes('/node_modules/') &&
	!path.startsWith('node:') &&
	// dev's generated glue is not yours; a BUILD's output is where your code runs when the build has no
	// sourcemaps (the usual production one) — its frames are told apart by the module map, so the
	// category already says whose a chunk line is
	(!path.includes('/.svelte-kit/') || path.includes('/.svelte-kit/output/')) &&
	!path.includes('/ogygia/src/') &&
	!path.includes('/ogygia/dist/');

const r2 = (n: number) => Math.round(n * 100) / 100;

export function build_ledger(input: LedgerInput): LedgerLine[] {
	interface Acc {
		path: string;
		file: string;
		line: number;
		cpu_ms: number;
		alloc_bytes: number;
		gc_ms: number;
		retained_bytes: number;
		who: Map<string, number>;
		fn?: string;
		fn_ms: number;
		mem_in_fn?: boolean;
		lib_ms: number;
		libs: LibCall[];
		mem_via?: string;
		grown_bytes: number;
		half_bytes: number;
		merged?: { from: number; callee: string };
		merged_ms: number;
	}
	const by = new Map<string, Acc>();
	const acc = (path: string, file: string, line: number): Acc => {
		const k = path + '\0' + line;
		let a = by.get(k);
		if (!a)
			by.set(
				k,
				(a = {
					path,
					file,
					line,
					cpu_ms: 0,
					alloc_bytes: 0,
					gc_ms: 0,
					retained_bytes: 0,
					who: new Map(),
					fn_ms: 0,
					lib_ms: 0,
					libs: [],
					grown_bytes: 0,
					half_bytes: 0,
					merged_ms: 0
				})
			);
		return a;
	};
	const credit = (a: Acc, name: string, weight: number) =>
		a.who.set(name, (a.who.get(name) ?? 0) + weight);

	// CPU: each app function's hot lines (self time per source line)
	for (const f of input.functions) {
		if (!APP.has(f.category) || !f.lines?.length || !is_app_path(f.path)) continue;
		for (const l of f.lines) {
			if (l.line <= 0 || l.ms <= 0) continue;
			const a = acc(f.path, f.url || short_source(f.path), l.line);
			a.cpu_ms += l.ms;
			credit(a, f.name, l.ms);
			if (l.ms > a.fn_ms) ((a.fn = f.key), (a.fn_ms = l.ms));
		}
	}
	// MERGED CALLS, split back: V8 inlines a small function into its caller and the profile then
	// charges its time to a caller line, often the NEXT call's (`attachBrands(x)` on 82, its time on
	// 83 `filter((p) => matches(p))`), so one pattern takes another's cost and the other vanishes.
	// When a line beside it calls a function that has no frame of its own in the profile (it was
	// inlined), the line's time is split by the render profiled with inlining off: the line keeps its
	// own share (its self time in that render, plus any inlined function it calls itself), and each
	// neighbour gets its inlined callees' time. A callee that kept its frame already has its own time
	// and weighs nothing here.
	if (input.source && input.uninlined?.length) {
		const src = input.source;
		const un_by_name = new Map<string, { path: string; ms: number }[]>();
		/** the un-inlined render's self time per line of each app function */
		const un_lines = new Map<string, Map<number, number>>();
		for (const f of input.uninlined) {
			if (!APP.has(f.category) || f.total_ms <= 0 || !is_app_path(f.path) || f.name.startsWith('('))
				continue;
			const list = un_by_name.get(f.name) ?? [];
			list.push({ path: f.path, ms: f.total_ms });
			un_by_name.set(f.name, list);
			if (f.lines?.length) {
				const m = un_lines.get(f.name + '\0' + f.path) ?? new Map<number, number>();
				for (const l of f.lines) m.set(l.line, (m.get(l.line) ?? 0) + l.ms);
				un_lines.set(f.name + '\0' + f.path, m);
			}
		}
		// KEPT ITS FRAME: its time per render in the profile is at least a quarter of its un-inlined
		// time (which runs slower, inlining off). V8 can inline a function at most call sites and leave
		// a sliver of a frame from one: 0.25 ms against 40 ms is inlined all the same
		const renders = Math.max(1, input.renders ?? 1);
		const main_ms = new Map<string, number>();
		for (const f of input.functions)
			if (APP.has(f.category))
				main_ms.set(
					f.name + '\0' + f.path,
					(main_ms.get(f.name + '\0' + f.path) ?? 0) + f.total_ms
				);
		const kept_frame = (name: string, path: string, un_ms: number) =>
			(main_ms.get(name + '\0' + path) ?? 0) / renders >= un_ms * 0.25;
		/** an app function called on this line that ran with no frame of its own: its un-inlined time */
		const inlined_calls = (line: string, caller: string | undefined) => {
			const out: { name: string; ms: number }[] = [];
			const t = tokens(line);
			for (let k = 0; k + 1 < t.length; k++) {
				if (t[k + 1] !== '(' || t[k - 1] === 'function' || t[k] === caller) continue;
				const hits = un_by_name.get(t[k]);
				// one function of that name, or the name is ambiguous and nothing is moved
				if (
					hits?.length !== 1 ||
					kept_frame(t[k], hits[0].path, hits[0].ms) ||
					out.some((o) => o.name === t[k])
				)
					continue;
				out.push({ name: t[k], ms: hits[0].ms });
			}
			return out;
		};
		const touched = new Set<Acc>();
		for (const a of [...by.values()]) {
			if (a.cpu_ms <= 0 || touched.has(a)) continue;
			const caller = a.fn?.split(' ')[0];
			const here = src(a.path, a.line, a.line)?.lines[0];
			const own = here ? inlined_calls(here, caller) : [];
			// the line's own work, as the un-inlined render measured it; unknown when the caller is not
			// in that profile, and then only a line with an inlined call of its own is split
			const caller_lines = caller ? un_lines.get(caller + '\0' + a.path) : undefined;
			if (!caller_lines && !own.length) continue;
			const own_ms = (caller_lines?.get(a.line) ?? 0) + own.reduce((s, c) => s + c.ms, 0);
			const win = src(a.path, Math.max(1, a.line - 2), a.line + 1);
			if (!win) continue;
			const beside: { line: number; calls: { name: string; ms: number }[] }[] = [];
			for (let i = 0; i < win.lines.length; i++) {
				const at = win.start + i;
				if (at === a.line) continue;
				const calls = inlined_calls(win.lines[i], caller);
				if (calls.length) beside.push({ line: at, calls });
			}
			if (!beside.length) continue;
			const total = own_ms + beside.reduce((s, b) => s + b.calls.reduce((x, c) => x + c.ms, 0), 0);
			if (total <= 0) continue;
			const pool = a.cpu_ms;
			for (const b of beside) {
				const ms = (pool * b.calls.reduce((x, c) => x + c.ms, 0)) / total;
				if (ms <= 0) continue;
				const to = acc(a.path, a.file, b.line);
				to.cpu_ms += ms;
				a.cpu_ms -= ms;
				for (const c of b.calls) credit(to, c.name, ms / b.calls.length);
				to.fn ??= a.fn;
				// the biggest move names where it came from
				if (!to.merged || ms > to.merged_ms)
					((to.merged = { from: a.line, callee: b.calls[0].name }), (to.merged_ms = ms));
				touched.add(to);
			}
			touched.add(a);
		}
	}
	// LIBRARY TIME, on the app line that called it: each app function's library callees (from the
	// profile's call tree) matched to the lines of its body that call that name. A name the body
	// never spells (a callback the library was handed, an indirect call) charges no line: better
	// no line than a guessed one.
	if (input.source) {
		const pkg_by_key = new Map<string, string>();
		for (const f of input.functions) if (f.pkg) pkg_by_key.set(f.key, f.pkg);
		// the package a callee belongs to: the analyzer's own label, else its node_modules path
		const pkg_for = (c: { key: string; category: FrameCategory; file: string; pkg?: string }) =>
			c.pkg ?? pkg_by_key.get(c.key) ?? (c.category === 'node' ? 'Node' : pkg_of(c.file));
		const aliases = new Map<string, Map<string, string[]>>();
		const aliases_of = (path: string) => {
			let al = aliases.get(path);
			if (!al) aliases.set(path, (al = import_aliases(input.source!, path)));
			return al;
		};
		// the inlining-off render, by function and by key (its callees name keys of the same render)
		const un = input.uninlined ?? [];
		const un_by_fn = new Map<string, (typeof un)[number]>();
		const un_by_key = new Map<string, (typeof un)[number]>();
		for (const u of un) {
			if (!APP.has(u.category)) continue;
			if (u.key) un_by_key.set(u.key, u);
			un_by_fn.set(u.name + '\0' + u.path, u);
		}
		/** where `f` really entered package `pkg`, from the inlining-off render: the app lines (in
		 *  `f`, or in the app functions it calls, three deep) that call into that package — each
		 *  given a share of `ms` by what it called there. Empty when that render cannot say */
		const entered_by = (f: FrameStat, pkg: string, ms: number) => {
			const found: { path: string; file: string; line: number; w: number; fn: string }[] = [];
			const start = un_by_fn.get(f.name + '\0' + f.path);
			if (!start) return only_call(f, ms);
			const seen = new Set<unknown>([start]);
			let level: (typeof un)[number][] = [start];
			for (let depth = 0; depth < 4 && level.length && !found.length; depth++) {
				const next: (typeof un)[number][] = [];
				for (const g of level) {
					if (!g.callees?.length || !g.line || !is_app_path(g.path)) continue;
					const body = function_body(input.source!, g.path, g.line);
					if (!body) continue;
					for (const d of g.callees) {
						if (APP.has(d.category)) {
							const u = un_by_key.get(d.key);
							if (u && !seen.has(u)) {
								seen.add(u);
								next.push(u);
							}
							continue;
						}
						if (!LIB.has(d.category) || d.name.startsWith('(') || pkg_for(d) !== pkg) continue;
						const names = [d.name, ...(aliases_of(g.path).get(d.name) ?? [])];
						const lines: number[] = [];
						for (let i = 0; i < body.lines.length; i++)
							if (calls_name(body.lines[i], names)) lines.push(body.start + i);
						for (const line of lines)
							found.push({
								path: g.path,
								file: g.url || short_source(g.path),
								line,
								w: d.ms / lines.length,
								fn: g.key ?? f.key
							});
					}
				}
				level = next;
			}
			const total = found.reduce((s, x) => s + x.w, 0);
			return total > 0
				? found.map((x) => ({ path: x.path, file: x.file, line: x.line, ms: (ms * x.w) / total, fn: x.fn }))
				: only_call(f, ms);
		};
		/** the one line of `f`'s body that calls anything, when there is exactly one (a loop that
		 *  awaits a timer per turn, a wrapper around one library call): the library time came from
		 *  there, whatever V8 inlined. The inlining-off render is one render; a short function can
		 *  have no sample in it */
		const only_call = (f: FrameStat, ms: number) => {
			const body = function_body(input.source!, f.path, f.line);
			if (!body) return [];
			let at = -1;
			for (let i = 0; i < body.lines.length; i++) {
				const t = tokens(body.lines[i]);
				let calls = false;
				for (let k = 0; k + 1 < t.length && !calls; k++)
					calls = t[k + 1] === '(' && t[k - 1] !== 'function' && !CONTROL.has(t[k]) && ID_START(t[k]);
				if (!calls) continue;
				// the function's own header (`async function drainJobs(jobs)`) is not a call
				if (i === 0 && t.includes('function')) continue;
				if (at !== -1) return [];
				at = body.start + i;
			}
			return at === -1
				? []
				: [{ path: f.path, file: f.url || short_source(f.path), line: at, ms, fn: f.key }];
		};
		for (const f of input.functions) {
			if (!APP.has(f.category) || !f.callees?.length || f.line <= 0 || !is_app_path(f.path))
				continue;
			// the framework's own calls (Kit's `resolve`, `json`) are how the app is served, not a
			// library the line chose: never charged as library time
			const libs = f.callees.filter(
				(c) => LIB.has(c.category) && !c.name.startsWith('(') && !is_framework_pkg(pkg_for(c))
			);
			if (!libs.length) continue;
			const body = function_body(input.source, f.path, f.line);
			if (!body) continue;
			let al = aliases.get(f.path);
			if (!al) aliases.set(f.path, (al = import_aliases(input.source, f.path)));
			for (const c of libs) {
				const names = [c.name, ...(al.get(c.name) ?? [])];
				const at: number[] = [];
				// A PATTERN RUNNING: V8 names a compiled regex's own code `RegExp: <source>`, a name
				// no line spells. The line that writes that literal runs it; else the lines calling a
				// regex method (a pattern built from a string, or passed in)
				const re = c.name.startsWith(REGEXP_FRAME) ? c.name.slice(REGEXP_FRAME.length) : null;
				if (re !== null) {
					for (let i = 0; i < body.lines.length; i++)
						if (body.lines[i].includes(`/${re}/`)) at.push(body.start + i);
					if (!at.length)
						for (let i = 0; i < body.lines.length; i++)
							if (calls_name(body.lines[i], REGEXP_METHODS)) at.push(body.start + i);
				}
				for (let i = 0; re === null && i < body.lines.length; i++)
					if (calls_name(body.lines[i], names)) at.push(body.start + i);
				const targets: { path: string; file: string; line: number; ms: number; fn: string }[] =
					at.map((line) => ({
						path: f.path,
						file: f.url || short_source(f.path),
						line,
						ms: c.ms / at.length,
						fn: f.key
					}));
				// NO LINE SPELLS IT: V8 inlined the library's entry into this function (valibot's
				// `safeParse` gone, its inner `~run` left under the app's `load`; `setImmediate` gone,
				// Node's `initAsyncResource` under the loop). The render with inlining off kept every
				// frame: there, the app lines that call into the same package, under this function
				if (!targets.length) targets.push(...entered_by(f, pkg_for(c), c.ms));
				for (const t of targets) {
					const a = acc(t.path, t.file, t.line);
					a.lib_ms += t.ms;
					a.libs.push({
						name: c.name,
						pkg: pkg_for(c),
						ms: r2(t.ms),
						...(targets.length > 1 ? { shared: targets.length } : {})
					});
					credit(a, c.name, t.ms);
					if (!a.fn) a.fn = t.fn;
				}
			}
		}
	}
	// An allocation's `at` is the line its function STARTS on (the heap profile records functions,
	// not lines). When that function also has CPU lines, its memory joins its hottest line, so one
	// problem reads as one row, flagged as the function's memory.
	const hottest = new Map<string, { file: string; line: number }>();
	for (const f of input.functions) {
		if (!APP.has(f.category) || !f.lines?.length || f.line <= 0 || !is_app_path(f.path)) continue;
		let best = f.lines[0];
		for (const l of f.lines) if (l.ms > best.ms) best = l;
		if (best.line > 0 && best.ms > 0)
			hottest.set(f.path + '\0' + f.line, { file: f.url || short_source(f.path), line: best.line });
	}
	const mem_row = (at: { path: string; line: number }): Acc => {
		const h = hottest.get(at.path + '\0' + at.line);
		if (!h) return acc(at.path, short_source(at.path), at.line);
		const a = acc(at.path, h.file, h.line);
		a.mem_in_fn = true;
		return a;
	};

	// Memory a LIBRARY made with no app frame above it (its continuation after an await) has no
	// app line of its own: it goes to the app line that calls into that package the most (the
	// library pass above found it), flagged, like the library's CPU.
	const entry_of_pkg = new Map<string, { a: Acc; ms: number }>();
	for (const a of by.values()) {
		for (const lc of a.libs) {
			const e = lc.pkg ? entry_of_pkg.get(lc.pkg) : undefined;
			if (lc.pkg && (!e || lc.ms > e.ms)) entry_of_pkg.set(lc.pkg, { a, ms: lc.ms });
		}
	}
	const pkg_row = (url: string | undefined): Acc | undefined => {
		const i = url ? url.lastIndexOf('/node_modules/') : -1;
		if (!url || i === -1) return undefined;
		const pkg = pkg_of(url.slice(i + 14));
		const e = entry_of_pkg.get(pkg);
		if (e) e.a.mem_via = pkg;
		return e?.a;
	};
	const row_for = (at: { path: string; line: number } | undefined, url: string): Acc | undefined =>
		at && at.line > 0 && is_app_path(at.path) ? mem_row(at) : !at ? pkg_row(url) : undefined;

	// allocations + the GC they caused, on the app line each maker is charged to
	for (const m of input.makers ?? []) {
		const a = row_for(m.at, m.url);
		if (!a) continue;
		a.alloc_bytes += m.allocated;
		a.gc_ms += m.gc_ms;
		// the weight is a rough ms-equivalent so one list can order cpu and bytes together
		credit(a, m.name, m.allocated / 1e6);
	}
	// what a render left alive
	for (const s of input.retained ?? []) {
		const a = row_for(s.at, s.url);
		if (!a) continue;
		a.retained_bytes += s.bytes;
		credit(a, s.name, s.bytes / 1e6);
	}
	// what the same lines still held after `renders` more (the growth check): a leaking line holds
	// about `renders` times its one-render amount; one feeding a bounded cache, about once
	for (const s of input.grown?.sites ?? []) {
		const a = row_for(s.at, s.url);
		if (a) a.grown_bytes += s.bytes;
	}
	for (const s of input.grown?.half?.sites ?? []) {
		const a = row_for(s.at, s.url);
		if (a) a.half_bytes += s.bytes;
	}

	const rows = [...by.values()];
	// a line's CPU is its own plus the library time it caused: both are what changing it changes
	const tot_cpu = rows.reduce((s, r) => s + r.cpu_ms + r.lib_ms, 0) || 1;
	const tot_alloc = rows.reduce((s, r) => s + r.alloc_bytes, 0) || 1;
	const tot_ret = rows.reduce((s, r) => s + r.retained_bytes, 0) || 1;
	const raw = (r: Acc) =>
		(r.cpu_ms + r.lib_ms) / tot_cpu + r.alloc_bytes / tot_alloc + r.retained_bytes / tot_ret;
	// rank on the exact share (rounded scores tie), then shape only the rows that are kept
	rows.sort((a, b) => raw(b) - raw(a));
	return rows.slice(0, input.limit ?? 40).map((r) => {
		const code = input.code?.(r.path, r.line)?.trim();
		return {
			path: r.path,
			file: r.file,
			line: r.line,
			...(code ? { code: code.length > 140 ? code.slice(0, 139) + '…' : code } : {}),
			cpu_ms: r2(r.cpu_ms),
			alloc_bytes: Math.round(r.alloc_bytes),
			gc_ms: r2(r.gc_ms),
			retained_bytes: Math.round(r.retained_bytes),
			who: [...r.who]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 4)
				.map(([n]) => n),
			...(r.fn ? { fn: r.fn } : {}),
			...(r.mem_in_fn && (r.alloc_bytes > 0 || r.retained_bytes > 0) ? { mem_in_fn: true } : {}),
			...(r.mem_via && (r.alloc_bytes > 0 || r.retained_bytes > 0) ? { mem_via: r.mem_via } : {}),
			...(input.grown && r.retained_bytes > 0
				? {
						// the halfway read caught none of this line (the sampler is random): it says nothing,
						// so the single read decides
						grows:
							input.grown.half && r.half_bytes > 0
								? confirmed(
										grows_between(
											r.half_bytes,
											r.grown_bytes,
											input.grown.half.renders,
											input.grown.renders
										),
										r.grown_bytes,
										r.retained_bytes,
										input.grown.renders,
										{ bytes: r.half_bytes, renders: input.grown.half.renders }
									)
								: grows_of(r.grown_bytes, r.retained_bytes, input.grown.renders)
					}
				: {}),
			lib_ms: r2(r.lib_ms),
			...(r.libs.length ? { libs: r.libs.sort((a, b) => b.ms - a.ms).slice(0, 4) } : {}),
			...(r.merged ? { merged: r.merged } : {}),
			score: r2(raw(r))
		};
	});
}
