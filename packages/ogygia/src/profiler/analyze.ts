/**
 * Analysis of a raw V8 .cpuprofile into readable aggregates.
 *
 * Framework-blind: understands Svelte/SvelteKit/Vite conventions when it sees
 * them (a `.svelte` URL, a `node_modules` segment) but works on any Node
 * server profile. No imports from the rest of ogygia — this file plus
 * report.ts/index.ts can be dropped into any SvelteKit project.
 */

import { build_timeline, type Timeline, type TimelineInput } from './timeline.js';

export interface CallFrame {
	functionName: string;
	scriptId?: string;
	url: string;
	lineNumber: number;
	columnNumber: number;
}

export interface ProfileNode {
	id: number;
	callFrame: CallFrame;
	hitCount?: number;
	children?: number[];
	/** V8's per-LINE sample counts inside this function (1-based lines of the script) */
	positionTicks?: { line: number; ticks: number }[];
	/** why V8 threw this function out of optimized code, when it did (`wrong map`, `not a Smi`…) */
	deoptReason?: string;
}

/** a function V8 deoptimized during the window, with the reasons it gave */
export interface DeoptRow {
	key: string;
	name: string;
	url: string;
	line: number;
	category: FrameCategory;
	reasons: Record<string, number>;
	count: number;
	self_ms: number;
}

export interface CpuProfile {
	nodes: ProfileNode[];
	/** microseconds */
	startTime: number;
	/** microseconds */
	endTime: number;
	samples?: number[];
	/** microseconds between consecutive samples */
	timeDeltas?: number[];
}

export type FrameCategory =
	| 'component' // a Svelte component's SSR function
	| 'app' // first-party project code
	| 'dependency' // node_modules
	| 'svelte' // svelte internals
	| 'node' // node: core modules
	| 'gc'
	| 'idle'
	| 'v8' // (program), (compile) etc.
	| 'profiler' // this profiler's own frames
	| 'unknown';

/** One call path into a function: the nearest callers first, and how much of the function's time
 *  (inclusive — the subtree reached through this exact path) came this way. */
export interface CallStack {
	ms: number;
	/** nearest caller first; `n` = display name, `f` = `file:line` ('' for native), `c` = category
	 *  (the UI dims framework/runtime frames so your own code stands out) */
	frames: { n: string; f: string; c: FrameCategory }[];
}

export interface FrameStat {
	/** the aggregation identity (`C:<name>` for a component, `<name> <url>` otherwise) */
	key: string;
	name: string;
	/** short display path (last segments, or the node_modules-relative path) */
	url: string;
	/** the full path as V8 (or the sourcemap) reported it — absolute in dev, so it can be opened */
	path: string;
	line: number;
	/** 1-based column; 0 when unknown */
	col: number;
	category: FrameCategory;
	/** package name when category is 'dependency' */
	pkg?: string;
	/** ms spent exactly here */
	self_ms: number;
	/** ms spent here plus everything it called (recursion counted once) */
	total_ms: number;
	/** exact invocation count from V8 precise coverage, when available (this frame's own count) */
	calls?: number;
	/** the heaviest call paths into this function (filled for the hot functions and every component) */
	stacks?: CallStack[];
	/** components: ms spent BUILDING MARKUP — Svelte's server internals (escape, attr, push…) run
	 *  under this component with no nearer component — versus RUNNING LOGIC — its own script and
	 *  the app / dependency / node code it calls. Nested components are in neither. */
	markup_ms?: number;
	logic_ms?: number;
	/** components: the component whose render contained most of this one's time — the parent of a
	 *  `{#each}` list's rows */
	parent?: string;
	/** THE HOT LINES: where inside this function the self time landed (V8's per-line ticks, mapped
	 *  through the sourcemap when one resolved), heaviest first */
	lines?: { line: number; ms: number }[];
	/** components, page mode: inclusive ms in EACH run — the spread says cache miss vs slow code */
	runs_ms?: number[];
}

export interface GroupStat {
	key: string;
	category: FrameCategory;
	self_ms: number;
}

export interface FlameNode {
	/** display name */
	n: string;
	/** category (for coloring) */
	c: FrameCategory;
	/** total ms, rounded to 2dp */
	t: number;
	/** self ms */
	s: number;
	/** file:line, '' when none */
	f: string;
	ch?: FlameNode[];
}

/**
 * ONE PATH, SEVERAL HOT FUNCTIONS: a caller in your code under which two or more of the hot
 * functions burn their time. Fixing the caller once (cache its result, call it less, move it out
 * of the render) addresses all of them, where the table would have you chase each on its own.
 */
export interface PathGroup {
	/** the caller to fix: a component or an app function */
	owner: { key: string; name: string; url: string; line: number; category: FrameCategory; total_ms: number; calls?: number };
	/** the hot functions under it, with the self time they burned on this path, heaviest first */
	fns: { key: string; name: string; url: string; line: number; category: FrameCategory; pkg?: string; ms: number }[];
	/** their summed self time under the owner */
	ms: number;
	/** how much of the owner's inclusive time that is */
	share: number;
	/** the call tree from the owner down to the hot functions — only the branches that reach one */
	tree: PathNode;
}

/** One node of a path tree: a frame between the owner and a hot function, or one of them. */
export interface PathNode {
	key: string;
	name: string;
	category: FrameCategory;
	/** `file:line`, '' when none */
	file: string;
	/** ms of hot-function self time that flowed through this node on the path */
	ms: number;
	/** a hot function itself (a leaf of the path, or a hot caller of another hot function) */
	hot: boolean;
	/** how many times it was called across the window (from coverage), when known */
	calls?: number | null;
	children: PathNode[];
}

/** One resolved frame of the stack index: what a sample's stack is made of. */
export interface StackFrameRef {
	/** the frame's display name (sourcemapped, renamed like every other row) */
	n: string;
	/** `file:line`, when known */
	f?: string;
	c: FrameCategory;
	/** the index of the parent frame in `frames`, -1 at a root */
	p: number;
}

/**
 * THE SAMPLES THEMSELVES, on the render's clock: every CPU sample inside the one window the
 * report explains, as `(time, length, leaf frame)` with the frame table the leaves hang from.
 * Every other table is an aggregate of this; this is the substrate they came from, so any range
 * of the render can be asked "what ran here" and any instant "what was the stack" — without
 * the raw profile (megabytes) and without re-resolving anything. Consecutive samples of one
 * leaf are folded (one entry with the summed length); beyond `MAX_INDEX_SAMPLES` the folded
 * entries are stride-sampled, the lengths kept so the sum still is the CPU time.
 */
export interface StackIndex {
	frames: StackFrameRef[];
	/** ms from the window's start, per sample */
	t: number[];
	/** ms each sample stands for */
	d: number[];
	/** the leaf frame per sample (an index into `frames`), -1 for an idle sample */
	leaf: number[];
	/** how many raw samples were folded into `t` */
	raw: number;
	window_ms: number;
}

const MAX_INDEX_SAMPLES = 20_000;

export interface Analysis {
	/** wall-clock length of the recording window in ms */
	duration_ms: number;
	/** ms the CPU was running the APP's JS/GC: everything except idle and the profiler's own frames */
	busy_ms: number;
	idle_ms: number;
	gc_ms: number;
	/** ms the CPU spent in the profiler's own code (its I/O tracker, its heap reads, its stack
	 *  captures): measured, reported, and kept OUT of every other number */
	overhead_ms: number;
	/** the profiler's own frames by self time (what the overhead was), a few */
	overhead_functions: { name: string; url: string; line: number; self_ms: number }[];
	/** page mode: the profiler's own CPU inside each run's window (what each run's wall time
	 *  carries that the app would not have paid); the rest of `overhead_ms` sits between runs
	 *  or before the first — the profiler's start-up scan of compiled code, its final reads */
	overhead_by_run_ms?: number[];
	/** the CPU segments over the WHOLE capture (every run), on the capture's clock — what was
	 *  running at any moment (the GC attribution names what ran when each pause fell) */
	capture_cpu?: { t0: number; t1: number; label: string; category: FrameCategory; file?: string }[];
	/** functions V8 deoptimized during the window, by self time */
	deopts: DeoptRow[];
	sample_count: number;
	/** every frame aggregated across the profile, sorted by self time desc */
	functions: FrameStat[];
	/** frames that look like Svelte component SSR functions, by total desc */
	components: FrameStat[];
	/** self time grouped by source file, desc */
	files: GroupStat[];
	/** self time grouped by npm package / category bucket, desc */
	buckets: GroupStat[];
	/** left-heavy call tree for the flamegraph, roots under a synthetic root */
	flame: FlameNode;
	/** true when at least one bundled frame was mapped back through a sourcemap */
	sourcemapped: boolean;
	/** ONE request's critical path + phases (page / request mode; absent for a plain window) */
	timeline?: Timeline;
	/** the samples inside that one window, with their stacks (the substrate every table came from) */
	stacks?: StackIndex;
	/** hot functions grouped by the one caller they share — the paths to fix, biggest first */
	paths: PathGroup[];
}

/**
 * The stack index of one window (see `StackIndex`). `frame_of` gives a node's resolved frame,
 * `parent_of` its parent node; only nodes on a sampled stack inside the window enter the table.
 */
export function build_stack_index(
	profile: CpuProfile,
	frame_of: (id: number) => { name: string; url: string; line: number; category: FrameCategory },
	parent_of: (id: number) => number | undefined,
	perf_start: number,
	window: { start: number; end: number }
): StackIndex | undefined {
	const samples = profile.samples ?? [];
	const deltas = profile.timeDeltas ?? [];
	if (!samples.length || !deltas.length) return undefined;
	const frames: StackFrameRef[] = [];
	const index_of = new Map<number, number>();
	const ref = (id: number): number => {
		const hit = index_of.get(id);
		if (hit !== undefined) return hit;
		const f = frame_of(id);
		const name = f.name;
		// an idle sample has no frame; (root) and (program) are V8's own bookkeeping, not a frame
		// on any stack the app would recognise — the stack starts below them
		if (f.category === 'idle' || name === '(root)' || name === '(program)') {
			index_of.set(id, -1);
			return -1;
		}
		const pid = parent_of(id);
		// the parent first, so a frame's index is always above its own (a stack reads bottom-up by walking p)
		const p = pid === undefined ? -1 : ref(pid);
		const i = frames.length;
		const url = short_path(f.url);
		frames.push({ n: name, ...(url ? { f: f.line > 0 ? `${url}:${f.line}` : url } : {}), c: f.category, p });
		index_of.set(id, i);
		return i;
	};
	const t: number[] = [];
	const d: number[] = [];
	const leaf: number[] = [];
	let raw = 0;
	let t_us = profile.startTime;
	const w0 = window.start;
	const w1 = window.end;
	let last_leaf = Number.NaN;
	for (let i = 0; i < samples.length; i++) {
		const delta = deltas[i] ?? 0;
		t_us += delta;
		if (delta <= 0) continue;
		const at = perf_start + (t_us - profile.startTime) / 1000;
		if (at < w0) continue;
		if (at > w1) break;
		raw++;
		const l = ref(samples[i]);
		const ms = delta / 1000;
		if (l === last_leaf && t.length) {
			d[d.length - 1] += ms;
			continue;
		}
		last_leaf = l;
		t.push(Math.max(0, at - w0 - ms));
		d.push(ms);
		leaf.push(l);
	}
	if (!t.length) return undefined;
	// past the cap: keep every k-th folded sample, its length grown to cover the ones dropped
	if (t.length > MAX_INDEX_SAMPLES) {
		const k = Math.ceil(t.length / MAX_INDEX_SAMPLES);
		const t2: number[] = [];
		const d2: number[] = [];
		const l2: number[] = [];
		for (let i = 0; i < t.length; i += k) {
			let sum = 0;
			for (let j = i; j < Math.min(i + k, t.length); j++) sum += d[j];
			t2.push(t[i]);
			d2.push(sum);
			l2.push(leaf[i]);
		}
		return { frames, t: t2.map(round2), d: d2.map(round3), leaf: l2, raw, window_ms: round2(w1 - w0) };
	}
	return { frames, t: t.map(round2), d: d.map(round3), leaf, raw, window_ms: round2(w1 - w0) };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------
// categorization

const component_name_re = /^[A-Z][A-Za-z0-9_$]*$/;
const ROUTE_FILE_FN_RE = /^_(page|layout|error)$/;
const SVELTE_BASENAME_RE = /([^/\\]+)\.svelte$/;
/** A rune module SOURCE (`state.svelte.ts`) compiles no component. Only the `.ts` spelling is
 *  excluded outright: Kit names a route's BUILT entry chunk `_page.svelte.js`, and that is the
 *  bundled component — a `.svelte.js` rune module's class stays a candidate and falls to app
 *  code through the structural confirmation (nothing under it calls Svelte's server internals). */
const SVELTE_MODULE_EXT_RE = /\.svelte\.ts$/;
/** A bundler's collision suffix (`Header$1`, `Header$2`): two components with one basename in
 *  one chunk. Stripped for naming and matching — the frame is still the `Header` component. */
const BUNDLER_SUFFIX_RE = /\$\d+$/;
const OGYGIA_OWN_RE = /\/ogygia\/(?:src|dist)\//;
/** ogygia's own wrapper components. The app's Vite compiles them into the app's chunks (a
 *  `.svelte` from a dependency is compiled by the consumer), so in a production profile they sit
 *  at a chunk URL with the component's name and no `.svelte` path to vouch for them — and every
 *  island page renders `Region` once per island, so it would top the Components table. */
const OGYGIA_WRAPPERS = new Set([
	'Region',
	'SlotBoundary',
	'LakeBoundary',
	'OgygiaBoundary',
	'NestedProvider',
	'LiveHost',
	'Blocks',
	'RawHtml',
	'Provide',
	'ClientBindingStub'
]);
const NON_IDENT_G = /[^a-zA-Z0-9_$]/g;

/** A frame name with the bundler's `$N` collision suffix removed. */
export function strip_bundler_suffix(name: string): string {
	return name.replace(BUNDLER_SUFFIX_RE, '');
}

/** SvelteKit endpoint/handler exports — capitalized, but not components. */
const handler_names = new Set([
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'HEAD',
	'OPTIONS',
	'fallback'
]);

/** Svelte derives the SSR function name from the filename: Header.svelte →
 * Header, +page.svelte → _page. Helper closures inside a component keep the
 * file's url but not a component-shaped name. A component-SHAPED name is only
 * a candidate: `analyze` confirms it structurally (see `confirm_components`). */
const is_component_name = (name: string): boolean =>
	!handler_names.has(name) &&
	(component_name_re.test(strip_bundler_suffix(name)) || ROUTE_FILE_FN_RE.test(name));

/** The component name a `.svelte` source file compiles to — Svelte's own rule
 * (`get_name` in the compiler): the basename with every non-identifier char
 * replaced by `_`, capitalised; a leading digit gets a `_`; the route files
 * become `_page` / `_layout` / `_error`. Used to name the anonymous inline-code
 * frame that V8 samples inside a component, and to tell the file's OWN function
 * (the component) from a same-cased helper class defined in it. Undefined for
 * a non-component file. */
export function component_name_from_file(url: string): string | undefined {
	const m = SVELTE_BASENAME_RE.exec(url);
	if (!m) return undefined;
	const base = m[1];
	if (base.startsWith('+')) {
		const kind = base.slice(1);
		return kind === 'page' || kind === 'layout' || kind === 'error' ? `_${kind}` : undefined;
	}
	let name = base.replace(NON_IDENT_G, '_');
	if (/^\d/.test(name)) name = '_' + name;
	return name.charAt(0).toUpperCase() + name.slice(1);
}

export function clean_url(url: string): string {
	if (url.startsWith('file://')) {
		try {
			return decodeURIComponent(url.slice('file://'.length));
		} catch {
			return url.slice('file://'.length);
		}
	}
	return url;
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;

/**
 * A sourcemap's `sources` are relative to the MAP FILE (`../../src/lib/Foo.svelte` from
 * `.svelte-kit/output/server/chunks/x.js.map`). Joined onto the chunk's own directory they become
 * the real path — absolute when V8 reported the chunk absolutely (a `vite preview`, adapter-node),
 * which is what lets a row open in an editor. Pure string work (no `node:path`): this module runs
 * anywhere. An absolute source, a URL, or a chunk with no directory passes through unchanged.
 */
export function join_source(chunk: string, source: string): string {
	if (!source || source.startsWith('/') || WIN_ABS_RE.test(source) || SCHEME_RE.test(source)) {
		return source;
	}
	const dir = clean_url(chunk).replace(/\\/g, '/');
	const slash = dir.lastIndexOf('/');
	if (slash === -1) return source;
	const out = dir.slice(0, slash).split('/');
	for (const seg of source.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') {
			if (out.length > 1 || (out.length === 1 && out[0] !== '')) out.pop();
			continue;
		}
		out.push(seg);
	}
	return out.join('/');
}

function package_of(url: string): string | undefined {
	const i = url.lastIndexOf('node_modules/');
	if (i === -1) return undefined;
	const rest = url.slice(i + 'node_modules/'.length);
	const parts = rest.split('/');
	if (parts[0]?.startsWith('@') && parts[1]) return `${parts[0]}/${parts[1]}`;
	return parts[0] || undefined;
}

export function categorize(frame: CallFrame): { category: FrameCategory; pkg?: string } {
	const name = frame.functionName;
	const url = clean_url(frame.url);

	if (!url) {
		if (name === '(garbage collector)') return { category: 'gc' };
		if (name === '(idle)') return { category: 'idle' };
		if (name === '(root)' || name === '(program)' || name.startsWith('(')) {
			return { category: 'v8' };
		}
	}
	// node:inspector frames are the profiler's own machinery — most notably
	// Profiler.start's one-time scan of all compiled code (~100ms on a big dev
	// heap), which lands on the window's first sample
	if (url.startsWith('node:inspector')) return { category: 'profiler' };
	// the promise hooks (`promiseInitHookWithDestroyTracking`, `registerDestroyHook`) run only while
	// an async_hooks tracker is installed — the profiler's own I/O tracker during a recording
	if (url.startsWith('node:internal/async_hooks')) return { category: 'profiler' };
	if (url.startsWith('node:')) return { category: 'node' };
	// a WebAssembly module's frames (`wasm://wasm/…`): undici's llhttp parser in practice — runtime
	if (url.startsWith('wasm://')) return { category: 'node' };
	if (url.includes('/ogygia/src/profiler/') || url.includes('/ogygia/dist/profiler/')) {
		return { category: 'profiler' };
	}

	const pkg = package_of(url);
	if (pkg === 'svelte') return { category: 'svelte', pkg };
	if (pkg) return { category: 'dependency', pkg };
	// ogygia's own runtime reached through a workspace link or a sourcemap (`packages/ogygia/src/…`,
	// no node_modules segment): its wrappers (Region.svelte, the boundaries) are the library, not
	// the app's components — they would otherwise top the Components table on every island page.
	if (OGYGIA_OWN_RE.test(url)) return { category: 'dependency', pkg: 'ogygia' };

	if (url.endsWith('.svelte')) {
		// only the file's OWN render function is "the component": Svelte names it after the file, so
		// a same-cased helper (`class Observer` in Header.svelte) and every inner closure land in
		// app code. `.svelte.ts` modules compile no component at all — plain app code below.
		const own = component_name_from_file(url);
		const stripped = strip_bundler_suffix(name);
		return {
			category:
				own !== undefined && (stripped === own || ROUTE_FILE_FN_RE.test(stripped)) ? 'component' : 'app'
		};
	}
	if (url) {
		// bundled server output: URLs point at chunks, but Svelte names the SSR function after the
		// component file, so a component-shaped name is the CANDIDATE signal. It is only a candidate —
		// `IntersectionObserver`, an `Error` subclass, any class constructor in app code looks the
		// same — and `analyze` keeps it a component only when its subtree reaches Svelte's server
		// internals (a component that renders anything calls `push`/`escape`); the rest become app.
		if (!SVELTE_MODULE_EXT_RE.test(url) && is_component_name(name)) {
			return OGYGIA_WRAPPERS.has(strip_bundler_suffix(name))
				? { category: 'dependency', pkg: 'ogygia' }
				: { category: 'component' };
		}
		return { category: 'app' };
	}
	// no url + a real (non-"(…)") name = a native runtime builtin — writev,
	// existsSync, cpuUsage, the UTF-8 codecs, flushCompileCache, etc. Bucket
	// these as `node` so they get a chip + colour instead of a bare "—". A
	// capitalized name here is NOT a component; compiled components carry a url.
	if (name && !name.startsWith('(')) return { category: 'node' };
	return { category: 'unknown' };
}

// ---------------------------------------------------------------------------
// sourcemap resolution (optional, prod builds with sourcemaps enabled)

interface SourceMapLike {
	sources: string[];
	names?: string[];
	sourceRoot?: string;
	mappings: string;
}

interface MappedLine {
	/** generated column -> [column, source index, original line, name index (-1 = none), original column] */
	cols: [number, number, number, number, number][];
}

const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64_lookup = new Map([...b64].map((c, i) => [c.charCodeAt(0), i]));

/** Decode one VLQ-encoded sourcemap `mappings` string into per-line column maps. */
export function decode_mappings(mappings: string): MappedLine[] {
	const lines: MappedLine[] = [];
	let cur: MappedLine = { cols: [] };
	lines.push(cur);
	let col = 0,
		src = 0,
		src_line = 0,
		src_col = 0,
		name_idx = 0;
	let i = 0;
	const len = mappings.length;
	while (i < len) {
		const ch = mappings.charCodeAt(i);
		if (ch === 59 /* ; */) {
			cur = { cols: [] };
			lines.push(cur);
			col = 0;
			i++;
			continue;
		}
		if (ch === 44 /* , */) {
			i++;
			continue;
		}
		// read one segment: 1, 4 or 5 VLQ values
		const seg: number[] = [];
		while (i < len) {
			let value = 0,
				shift = 0,
				digit: number;
			do {
				const d = b64_lookup.get(mappings.charCodeAt(i));
				if (d === undefined) return lines; // malformed; keep what we have
				digit = d;
				i++;
				value += (digit & 31) << shift;
				shift += 5;
			} while (digit & 32);
			seg.push(value & 1 ? -(value >>> 1) : value >>> 1);
			const next = i < len ? mappings.charCodeAt(i) : 0;
			if (next === 44 || next === 59 || i >= len) break;
		}
		col += seg[0];
		if (seg.length >= 4) {
			src += seg[1];
			src_line += seg[2];
			src_col += seg[3];
			if (seg.length >= 5) {
				name_idx += seg[4];
				cur.cols.push([col, src, src_line, name_idx, src_col]);
			} else {
				cur.cols.push([col, src, src_line, -1, src_col]);
			}
		}
	}
	return lines;
}

/**
 * Resolves generated positions back to source via `.map` files sitting next to
 * the chunks. `read` abstracts fs so this module stays platform-free. Holds a
 * cache and a `hit` flag, so it is a class rather than a closure.
 */
/** words that sit where a name would but are not one (`if (`, `return (`, `= function`, `=> {`) */
const RESERVED_NAME_RE = /^(?:if|for|while|switch|return|catch|await|typeof|function|new|else|do|in|of|throw|yield|void|delete|case|with|async)$/;

export class SourceMapResolver {
	/** whether any lookup succeeded */
	hit = false;
	readonly #read: (path: string) => string | undefined;
	readonly #cache = new Map<
		string,
		{ lines: MappedLine[]; sources: string[]; names: string[] } | null
	>();

	readonly #src_cache = new Map<string, string[] | null>();

	constructor(read: (path: string) => string | undefined) {
		this.#read = read;
	}

	/** The original source LINE at a mapped position, trimmed and cut: what an anonymous callback
	 *  IS (`tags.map(async (tag) => {`), for a label a name cannot give. Undefined when the source
	 *  is not on this machine. */
	line_at_source(source: string, line: number, max = 56): string | undefined {
		let lines = this.#src_cache.get(source);
		if (lines === undefined) {
			const text = this.#read(source);
			lines = text === undefined ? null : text.split('\n');
			this.#src_cache.set(source, lines);
		}
		const row = lines?.[line - 1]?.trim();
		if (!row) return undefined;
		return row.length > max ? row.slice(0, max - 1) + '…' : row;
	}

	/** The function name written in the ORIGINAL source at a mapped position (1-based line and
	 *  column), for a frame whose map carries no name there: `function foo(`, a method `foo(` /
	 *  `#foo(` / `async foo(`, or an arrow assigned to `foo` (`const foo = () =>`, `foo: () =>`).
	 *  Undefined for a true anonymous callback. Reads the source through the same `read`. */
	name_at_source(source: string, line: number, column: number): string | undefined {
		let lines = this.#src_cache.get(source);
		if (lines === undefined) {
			const text = this.#read(source);
			lines = text === undefined ? null : text.split('\n');
			this.#src_cache.set(source, lines);
		}
		const row = lines?.[line - 1];
		if (row === undefined) return undefined;
		const col = Math.max(0, Math.min(column - 1, row.length));
		const after = row.slice(col);
		const before = row.slice(0, col);
		const tries: [RegExp, string][] = [
			[/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, after],
			[/^(?:static\s+)?(?:async\s+)?(?:(?:get|set)\s+)?(#?[A-Za-z_$][\w$]*)\s*\(/, after],
			[/(?:const|let|var|,)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?$/, before],
			[/(#?[A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?$/, before],
			[/(?:static\s+)?(?:async\s+)?(#?[A-Za-z_$][\w$]*)\s*\(\s*$/, before]
		];
		for (const [re, text] of tries) {
			const name = re.exec(text)?.[1];
			// a keyword where a name would be (`async () =>`, `if (`) is not this function's name: keep looking
			if (name && !RESERVED_NAME_RE.test(name)) return name;
		}
		return undefined;
	}

	/** map a generated (url, line0, col0) to the original file/line/column (1-based), plus the
	 * original identifier at that position when the map carries `names` — that's
	 * what turns a bundled `(anonymous)` back into a real name */
	resolve(
		url: string,
		line: number,
		column: number
	): { source: string; line: number; column: number; name?: string; near_name?: string } | undefined {
		const path = clean_url(url);
		if (!path.endsWith('.js') && !path.endsWith('.mjs') && !path.endsWith('.cjs')) {
			return undefined;
		}
		let entry = this.#cache.get(path);
		if (entry === undefined) {
			entry = null;
			const raw = this.#read(path + '.map');
			if (raw) {
				try {
					const map = JSON.parse(raw) as SourceMapLike;
					if (typeof map.mappings === 'string' && Array.isArray(map.sources)) {
						const root = map.sourceRoot ?? '';
						entry = {
							lines: decode_mappings(map.mappings),
							sources: map.sources.map((s) => root + s),
							names: Array.isArray(map.names) ? map.names : []
						};
					}
				} catch {
					// unusable map — remember the miss
				}
			}
			this.#cache.set(path, entry);
		}
		if (!entry) return undefined;
		const cols = entry.lines[line]?.cols;
		if (!cols?.length) return undefined;
		// binary search for the last mapping at or before `column`
		let lo = 0,
			hi = cols.length - 1,
			best = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (cols[mid][0] <= column) {
				best = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		const m = best === -1 ? cols[0] : cols[best];
		const source = entry.sources[m[1]];
		if (!source) return undefined;
		this.hit = true;
		// the nearest NAMED mapping from the same source LINE just after this position: a minifier
		// maps a function's start (`function B(`, `B(){`) a few columns before the identifier that
		// carries the name, so the exact segment is often nameless while the next one is not
		let near_name: string | undefined;
		if (m[3] < 0 && best !== -1) {
			for (let d = 1; d <= 4 && !near_name; d++) {
				for (const i of [best + d, best - d]) {
					const s = cols[i];
					if (!s || s[1] !== m[1] || s[2] !== m[2] || s[3] < 0 || Math.abs(s[0] - column) > 32) continue;
					near_name = entry.names[s[3]];
					break;
				}
			}
		}
		return {
			source: join_source(path, source),
			line: m[2] + 1,
			column: (m[4] ?? 0) + 1,
			name: m[3] >= 0 ? entry.names[m[3]] : undefined,
			...(near_name ? { near_name } : {})
		};
	}
}

/** Build a {@link SourceMapResolver} backed by `.map` files next to the chunks. */
export function sourcemap_resolver(read: (path: string) => string | undefined): SourceMapResolver {
	return new SourceMapResolver(read);
}

// ---------------------------------------------------------------------------
// core analysis

function frame_key(f: CallFrame): string {
	return `${f.functionName} ${f.url} ${f.lineNumber}`;
}

function display_name(f: CallFrame): string {
	return f.functionName || '(anonymous)';
}

function short_path(url: string): string {
	const u = clean_url(url);
	const nm = u.lastIndexOf('node_modules/');
	if (nm !== -1) return u.slice(nm + 'node_modules/'.length);
	// keep the last few path segments so tables stay readable
	const parts = u.split('/');
	return parts.length > 4 ? parts.slice(-4).join('/') : u;
}

export function analyze(
	profile: CpuProfile,
	resolver?: SourceMapResolver,
	call_counts?: Record<string, number>,
	/** the profiled request's window + its outbound calls → the timeline (timeline.ts) */
	timeline_input?: TimelineInput,
	/** a display name for a frame the profile names badly — the island host wrappers Svelte names
	 *  after their hashed virtual file (`_b95bfb97fab` → `ProductCard (island host)`) */
	rename?: (name: string, url: string, stage: 'frame' | 'confirmed') => string | undefined,
	/** a category for a frame by its URL when the URL alone cannot say (a client chunk that the
	 *  build knows holds only the Svelte runtime); the frame's own categorisation runs first */
	url_category?: (url: string, name: string) => FrameCategory | { category: FrameCategory; pkg?: string } | undefined
): Analysis {
	// Invocation count per FRAME KEY, joined from coverage by the raw `<functionName>\0<url>` identity
	// (the same key #count_calls emits). Filled during the resolve loop, read when a FrameStat is created.
	const calls_by_key = new Map<string, number>();
	const by_id = new Map<number, ProfileNode>();
	for (const n of profile.nodes) by_id.set(n.id, n);
	/** µs per tick: V8's line ticks are sample counts, the profile's mean delta turns them into time */
	const samples_n = profile.samples?.length ?? 0;
	const us_per_tick = samples_n > 0 ? (profile.endTime - profile.startTime) / samples_n : 0;

	// --- self time per node ------------------------------------------------
	const self_us = new Map<number, number>();
	const samples = profile.samples ?? [];
	const deltas = profile.timeDeltas ?? [];
	if (samples.length && deltas.length) {
		for (let i = 0; i < samples.length; i++) {
			const d = deltas[i] ?? 0;
			if (d <= 0) continue;
			self_us.set(samples[i], (self_us.get(samples[i]) ?? 0) + d);
		}
	} else {
		// fall back to hitCount * average interval
		const total = profile.endTime - profile.startTime;
		let hits = 0;
		for (const n of profile.nodes) hits += n.hitCount ?? 0;
		const per_hit = hits > 0 ? total / hits : 0;
		for (const n of profile.nodes) {
			if (n.hitCount) self_us.set(n.id, n.hitCount * per_hit);
		}
	}

	// --- resolve identity (with optional sourcemaps) -----------------------
	interface Resolved {
		key: string;
		name: string;
		url: string;
		line: number;
		col: number;
		category: FrameCategory;
		pkg?: string;
		/** a component-shaped name in a chunk (no `.svelte` url to vouch for it): confirmed below */
		candidate: boolean;
	}
	const resolved = new Map<number, Resolved>();
	/** per function key: source line → µs (the hot lines), filled from every node's positionTicks */
	const line_us = new Map<string, Map<number, number>>();
	/** a node's line ticks, mapped to source lines when the frame was */
	const line_ticks_of = new Map<number, { line: number; us: number }[]>();
	for (const n of profile.nodes) {
		const f = n.callFrame;
		let url = f.url;
		let line = f.lineNumber + 1;
		let col = f.columnNumber + 1;
		let name = display_name(f);
		let cat = categorize(f);
		let hinted = false;
		if (url_category && f.url && (cat.category === 'app' || cat.category === 'component')) {
			const h = url_category(f.url, f.functionName);
			if (typeof h === 'string') cat = { category: h, ...(h === 'dependency' ? { pkg: 'ogygia' } : {}) };
			else if (h) cat = { category: h.category, ...(h.pkg ? { pkg: h.pkg } : {}) };
			hinted = !!h;
		}
		// a frame the URL hint filed as a dependency still gets its map (a browser chunk of the
		// runtime, minified): the real name and file are worth having in a dependency row too
		const mapping = resolver && (cat.category === 'app' || cat.category === 'component' || hinted);
		if (n.positionTicks?.length && us_per_tick > 0) {
			const ticks: { line: number; us: number }[] = [];
			for (const p of n.positionTicks) {
				// the tick's line is in the SCRIPT; map it to the source line like the frame itself
				const m = mapping ? resolver!.resolve(f.url, p.line - 1, 0) : undefined;
				ticks.push({ line: m ? m.line : p.line, us: p.ticks * us_per_tick });
			}
			line_ticks_of.set(n.id, ticks);
		}
		if (mapping) {
			const mapped = resolver!.resolve(f.url, f.lineNumber, f.columnNumber);
			if (mapped) {
				url = mapped.source;
				line = mapped.line;
				col = mapped.column;
				// a bundled anonymous frame often has a real name in the source — the map's `names`
				// entry at the function position recovers it; so does a MINIFIED one (`Y`, `Gr`: a
				// production client chunk), whose real name is the only useful one
				if (!f.functionName && mapped.name) name = mapped.name;
				else if (f.functionName && MINIFIED_NAME_RE.test(f.functionName)) {
					// exact map name, else the name written in the source at that spot, else a named
					// neighbour on the same source line
					const from_source = mapped.name ? undefined : resolver!.name_at_source(mapped.source, mapped.line, mapped.column);
					const better = mapped.name ?? from_source ?? mapped.near_name;
					if (better) name = better;
				}
				// re-categorize with the true file and the recovered name — unless the URL hint knew
				// better (a workspace-linked runtime maps to a path with no node_modules in it and
				// would read as app code): the hint's category and package stay
				const recat = categorize({
					...f,
					functionName: name === '(anonymous)' ? '' : name,
					url: mapped.source
				});
				if (!(hinted && recat.category === 'app')) cat = recat;
			}
		}
		// Inline component code (a tight loop, an IIFE) is compiled to its own
		// anonymous code region, so V8 samples it as a nameless frame sitting at
		// the component's own source file. Give it the component's name and
		// category, so the heavy work reads as the component instead of a stray
		// "(anonymous)", and merges into the component's self time.
		if ((!f.functionName || f.functionName === '(anonymous)') && cat.category !== 'dependency') {
			const derived = component_name_from_file(clean_url(url));
			if (derived) {
				name = derived;
				cat = { category: 'component' };
			}
		}
		// The bundler's `$1` on a component is a chunk collision, not a different component.
		if (cat.category === 'component') name = strip_bundler_suffix(name);
		if (rename) {
			const better = rename(name, url, 'frame');
			if (better) {
				name = better;
				cat = { category: 'component' };
			}
		}
		resolved.set(n.id, {
			key: '',
			name,
			url,
			line,
			col,
			category: cat.category,
			pkg: cat.pkg,
			candidate: cat.category === 'component' && !clean_url(url).endsWith('.svelte')
		});
	}

	// --- roots + parents ---------------------------------------------------
	const parent_of = new Map<number, number>();
	for (const n of profile.nodes) for (const c of n.children ?? []) parent_of.set(c, n.id);
	const roots = profile.nodes.filter((n) => !parent_of.has(n.id));

	// --- confirm components (structural) -----------------------------------
	// A component-shaped name in a bundled chunk is only a candidate: `IntersectionObserver`, an
	// `Error` subclass, a `class Foo` in app code all wear the same case. A Svelte SSR component
	// that renders anything calls Svelte's server internals (`push`, `escape_html`, `attr`…), so
	// the candidate is a component iff ONE of its occurrences has a `svelte` frame somewhere below
	// it — or the same name is vouched for by a `.svelte` url elsewhere in the profile (a
	// sourcemapped inline region of the same component). Everything else is app code. The route
	// functions (`_page`/`_layout`/`_error`) are always components: nothing else is named that way.
	const svelte_below = new Map<number, boolean>();
	const has_svelte_below = (node: ProfileNode): boolean => {
		const cached = svelte_below.get(node.id);
		if (cached !== undefined) return cached;
		let below = false;
		for (const c of node.children ?? []) {
			const child = by_id.get(c);
			if (!child) continue;
			const r = resolved.get(child.id)!;
			if (r.category === 'svelte' || has_svelte_below(child)) below = true;
		}
		svelte_below.set(node.id, below);
		return below;
	};
	const confirmed = new Set<string>();
	for (const n of profile.nodes) {
		const r = resolved.get(n.id)!;
		if (r.category !== 'component') continue;
		if (!r.candidate || ROUTE_FILE_FN_RE.test(r.name) || has_svelte_below(n)) confirmed.add(r.name);
	}
	for (const n of profile.nodes) {
		const r = resolved.get(n.id)!;
		if (r.candidate && !confirmed.has(r.name)) r.category = 'app';
		// a CONFIRMED candidate may still wear a minified name (a client chunk has no source map):
		// the renamer's second stage names it from what the build put in that chunk
		else if (r.candidate && rename) {
			const better = rename(r.name, r.url, 'confirmed');
			if (better) r.name = better;
		}
		// Components are keyed by name alone: Svelte bundles every component in a
		// route into one chunk, so the wrapper frame's url (…/_page.svelte.js) and
		// the sourcemapped inline frame's url (…/Foo.svelte) differ for the SAME
		// component. Name-keying merges them; other frames keep name+url.
		r.key = r.category === 'component' ? `C:${r.name}` : `${r.name} ${r.url}`;
		// Join this frame's invocation count from coverage, on the RAW identity (pre-sourcemap name+url).
		// A component key merges several raw frames (the named wrapper + anonymous inline regions) — only
		// the wrapper, whose raw name IS the component name, carries the render count; the inline loop's
		// own count would misreport it. Set once per key (the same function has one true count).
		if (call_counts && !calls_by_key.has(r.key)) {
			const f = n.callFrame;
			const c = call_counts[(f.functionName || '') + '\0' + f.url];
			if (
				c &&
				(r.category !== 'component' || strip_bundler_suffix(f.functionName) === r.name)
			) {
				calls_by_key.set(r.key, c);
			}
		}
	}

	// --- aggregate: self + (recursion-safe) total per function key ---------
	const agg = new Map<string, FrameStat>();
	const files = new Map<string, GroupStat>();
	const buckets = new Map<string, GroupStat>();
	let idle_us = 0;
	let gc_us = 0;
	let busy_us = 0;
	let overhead_us = 0;

	const path = new Map<string, number>(); // key -> occurrences on current stack
	/** inclusive µs per profile NODE (one node = one distinct call path) — what ranks the stacks */
	const node_total_us = new Map<number, number>();
	/** every node of a key, for the stacks below */
	const nodes_by_key = new Map<string, number[]>();
	// MARKUP vs LOGIC per component, and who rendered whom: the nearest component above a sample is
	// the one charged. Svelte's server internals under it are its markup; its own frames and the
	// app / dependency / node code it calls are its logic; a nested component is neither (that one
	// is charged instead). A component's outermost occurrence credits its total to the component it
	// sits under — the parent that renders it (a `{#each}` list's owner).
	const comp_stack: string[] = [];
	const markup_us = new Map<string, number>();
	const logic_us = new Map<string, number>();
	const parent_us = new Map<string, Map<string, number>>();

	const visit = (node: ProfileNode): number => {
		const r = resolved.get(node.id)!;
		const s = self_us.get(node.id) ?? 0;

		// A node whose key is already on the stack is a NESTED occurrence — a recursive call, or a
		// component's sourcemapped inner frame under its own bundled wrapper — and its time is inside
		// the outer one's: only the outermost occurrence stands for this call path in the stacks.
		const nested = (path.get(r.key) ?? 0) > 0;
		path.set(r.key, (path.get(r.key) ?? 0) + 1);
		if (!nested) {
			const list = nodes_by_key.get(r.key);
			if (list) list.push(node.id);
			else nodes_by_key.set(r.key, [node.id]);
		}
		const is_comp = r.category === 'component';
		const parent_comp = comp_stack[comp_stack.length - 1];
		if (is_comp) comp_stack.push(r.key);

		const ticks = line_ticks_of.get(node.id);
		if (ticks) {
			let m = line_us.get(r.key);
			if (!m) line_us.set(r.key, (m = new Map()));
			for (const t of ticks) m.set(t.line, (m.get(t.line) ?? 0) + t.us);
		}
		let stat = agg.get(r.key);
		if (!stat) {
			stat = {
				key: r.key,
				name: r.name,
				url: short_path(r.url),
				path: clean_url(r.url),
				line: r.line,
				col: r.col,
				category: r.category,
				pkg: r.pkg,
				self_ms: 0,
				total_ms: 0,
				calls: calls_by_key.get(r.key)
			};
			agg.set(r.key, stat);
		} else if (r.url.endsWith('.svelte') && !stat.url.endsWith('.svelte')) {
			// a merged component: prefer the real source file over the chunk path
			stat.url = short_path(r.url);
			stat.path = clean_url(r.url);
			stat.line = r.line;
			stat.col = r.col;
		}
		if (s > 0) {
			stat.self_ms += s / 1000;
			for (const [k, count] of path) {
				if (count > 0) agg.get(k)!.total_ms += s / 1000;
			}
			if (r.category === 'idle') idle_us += s;
			else if (r.category === 'profiler') overhead_us += s; // the profiler's own work: not the app's busy time
			else {
				busy_us += s;
				if (r.category === 'gc') gc_us += s;
			}
			const near = comp_stack[comp_stack.length - 1];
			if (near !== undefined) {
				if (r.category === 'svelte') markup_us.set(near, (markup_us.get(near) ?? 0) + s);
				else if (
					r.category === 'component' ||
					r.category === 'app' ||
					r.category === 'dependency' ||
					r.category === 'node'
				)
					logic_us.set(near, (logic_us.get(near) ?? 0) + s);
			}
			// group by file
			if (r.url) {
				const fk = short_path(r.url);
				const fg = files.get(fk) ?? { key: fk, category: r.category, self_ms: 0 };
				fg.self_ms += s / 1000;
				files.set(fk, fg);
			}
			// group by package / bucket
			// TODO(dev-budget): when `dev`, Vite's own cost (pkg vite / .vite / rolldown / esbuild —
			// transform + module load, absent from the prod path) plus the profiler overhead dominate the
			// window and drown the app's real proportion. Do the exclusion HERE (mark these buckets, or emit
			// an `app_ms` total that nets them out) so every consumer — report_json, the dashboard UI, the
			// `ogygia_profile` MCP tool — shows the same "% of app time" without re-deriving it. The MCP
			// currently strips them itself (mcp.ts render_profile); fold that in as the canonical behaviour.
			const bk =
				r.category === 'dependency' || r.category === 'svelte'
					? (r.pkg ?? 'node_modules')
					: r.category === 'component' || r.category === 'app'
						? 'your code'
						: r.category === 'node'
							? 'node core'
							: r.category === 'gc'
								? 'garbage collection'
								: r.category === 'idle'
									? 'idle (waiting)'
									: r.category === 'profiler'
										? 'profiler overhead'
										: 'v8 internals';
			const bg = buckets.get(bk) ?? { key: bk, category: r.category, self_ms: 0 };
			bg.self_ms += s / 1000;
			buckets.set(bk, bg);
		}

		let total = s;
		for (const c of node.children ?? []) {
			const child = by_id.get(c);
			if (child) total += visit(child);
		}
		node_total_us.set(node.id, total);
		if (is_comp) {
			comp_stack.pop();
			if (!nested && parent_comp !== undefined && parent_comp !== r.key) {
				let m = parent_us.get(r.key);
				if (!m) parent_us.set(r.key, (m = new Map()));
				m.set(parent_comp, (m.get(parent_comp) ?? 0) + total);
			}
		}

		const left = path.get(r.key)! - 1;
		if (left === 0) path.delete(r.key);
		else path.set(r.key, left);
		return total;
	};
	// iterative safety: profiles can nest deeply, but V8 stacks max out well
	// below JS recursion limits, so plain recursion holds
	for (const root of roots) visit(root);

	// --- call stacks: the heaviest paths into a function -------------------
	// A profile node IS one distinct call path, so a function's stacks are its nodes ranked by the
	// inclusive time that flowed through each; the frames are the parents walked up from there,
	// nearest caller first, capped so a deep Kit/Svelte chain stays readable. V8's pseudo frames
	// ((root), (program)) never show. Only the tables' rows get them (below), keeping reports small.
	const STACKS_PER_FN = 3;
	const STACK_DEPTH = 14;
	// A component is SEVERAL frames on a real stack: its sourcemapped body (`Card.svelte:1`) inside
	// the bundled wrapper the route chunk exports (`_page.svelte.js:317`), an inline closure of its
	// template (`Card.svelte:40`, renamed to the component above) inside its body — with the
	// renderer's `child` / `component` / `each` calls between them. One component, one frame: runs
	// of the same component separated only by svelte internals fold into one, keeping the `.svelte`
	// location (the body's, the lowest line). A component reached again through OTHER code (a
	// nested island's Region, a load) stays a second frame.
	const frames_above = (id: number): CallStack['frames'] => {
		const frames: CallStack['frames'] = [];
		let cur = parent_of.get(id);
		while (cur !== undefined && frames.length < STACK_DEPTH) {
			const r = resolved.get(cur)!;
			if (!r.name.startsWith('(')) {
				const f = { n: r.name, f: r.url ? `${short_path(r.url)}:${r.line}` : '', c: r.category };
				if (r.category === 'component') {
					// walk back over trailing svelte frames to the last component pushed
					let i = frames.length - 1;
					while (i >= 0 && frames[i].c === 'svelte') i--;
					const prev = i >= 0 && frames[i].c === 'component' && frames[i].n === r.name ? frames[i] : null;
					if (prev) {
						frames.length = i + 1; // drop the svelte frames between
						const is_body = (x: { f: string }) => x.f.includes('.svelte:');
						// keep the `.svelte` location; between two, the lower line (the body over a closure)
						if (is_body(f) && (!is_body(prev) || r.line < Number(prev.f.split(':').pop()))) frames[i] = f;
						cur = parent_of.get(cur);
						continue;
					}
				}
				frames.push(f);
			}
			cur = parent_of.get(cur);
		}
		return frames;
	};
	const stacks_of = (key: string): CallStack[] => {
		const ids = nodes_by_key.get(key);
		if (!ids) return [];
		// V8 keeps one node per CALL POSITION, so the same readable path (the same functions, called
		// from two lines of one component) arrives as several nodes: merge by the path's text.
		const by_path = new Map<string, CallStack>();
		for (const id of ids) {
			const us = node_total_us.get(id) ?? 0;
			if (us <= 0) continue;
			const frames = frames_above(id);
			const sig = frames.map((f) => f.n + '\0' + f.f).join('\n');
			const seen = by_path.get(sig);
			if (seen) seen.ms += us;
			else by_path.set(sig, { ms: us, frames });
		}
		return [...by_path.values()]
			.sort((a, b) => b.ms - a.ms)
			.slice(0, STACKS_PER_FN)
			.map((s) => ({ ms: round2(s.ms / 1000), frames: s.frames }));
	};

	// --- flamegraph tree (merged call tree with totals) --------------------
	const to_flame = (node: ProfileNode): FlameNode | null => {
		const r = resolved.get(node.id)!;
		const s = (self_us.get(node.id) ?? 0) / 1000;
		const children: FlameNode[] = [];
		// merge children that share a key so repeated calls read as one bar
		const merged = new Map<string, FlameNode>();
		for (const c of node.children ?? []) {
			const child = by_id.get(c);
			if (!child) continue;
			const fn = to_flame(child);
			if (!fn) continue;
			const existing = merged.get(fn.n + ' ' + fn.f);
			if (existing) {
				existing.t += fn.t;
				existing.s += fn.s;
				if (fn.ch) existing.ch = [...(existing.ch ?? []), ...fn.ch];
			} else {
				merged.set(fn.n + ' ' + fn.f, fn);
			}
		}
		for (const m of merged.values()) children.push(m);
		children.sort((a, b) => b.t - a.t);
		const total = s + children.reduce((acc, c) => acc + c.t, 0);
		if (total < 0.005) return null; // prune empty branches
		const fn: FlameNode = {
			n: r.name,
			c: r.category,
			t: round2(total),
			s: round2(s),
			f: r.url ? `${short_path(r.url)}:${r.line}` : ''
		};
		if (children.length) fn.ch = children;
		return fn;
	};
	const flame_roots: FlameNode[] = [];
	for (const root of roots) {
		// (root) node itself is noise — lift its children
		const r = resolved.get(root.id)!;
		if (r.name === '(root)') {
			for (const c of root.children ?? []) {
				const child = by_id.get(c);
				if (!child) continue;
				const fn = to_flame(child);
				if (fn && fn.c !== 'idle') flame_roots.push(fn);
			}
		} else {
			const fn = to_flame(root);
			if (fn && fn.c !== 'idle') flame_roots.push(fn);
		}
	}
	flame_roots.sort((a, b) => b.t - a.t);
	const flame: FlameNode = {
		n: 'all',
		c: 'v8',
		t: round2(flame_roots.reduce((a, c) => a + c.t, 0)),
		s: 0,
		f: '',
		ch: flame_roots
	};

	// --- deoptimizations: the reasons V8 wrote into the profile, per function --------------
	const deopt_by_key = new Map<string, DeoptRow>();
	for (const n of profile.nodes) {
		if (!n.deoptReason) continue;
		const r = resolved.get(n.id);
		if (!r || r.category === 'idle' || r.category === 'gc' || r.category === 'v8' || r.category === 'profiler') continue;
		let row = deopt_by_key.get(r.key);
		if (!row) deopt_by_key.set(r.key, (row = { key: r.key, name: r.name, url: short_path(r.url), line: r.line, category: r.category, reasons: {}, count: 0, self_ms: 0 }));
		row.reasons[n.deoptReason] = (row.reasons[n.deoptReason] ?? 0) + 1;
		row.count++;
	}
	for (const row of deopt_by_key.values()) row.self_ms = round2(agg.get(row.key)?.self_ms ?? 0);
	const deopts = [...deopt_by_key.values()].sort((x, y) => y.self_ms - x.self_ms || y.count - x.count).slice(0, 40);

	// --- final tables ------------------------------------------------------
	// the profiler's own frames, kept apart: what its overhead WAS (the report shows the top few
	// next to the number it took out)
	const overhead_functions = [...agg.values()]
		.filter((f) => f.category === 'profiler' && f.self_ms >= 0.01)
		.sort((x, y) => y.self_ms - x.self_ms)
		.slice(0, 10)
		.map((f) => ({ name: f.name, url: f.url, line: f.line, self_ms: round2(f.self_ms) }));
	const functions = [...agg.values()]
		.filter(
			(f) =>
				f.self_ms >= 0.01 &&
				// drop v8 pseudo frames and our own machinery (still visible in the
				// buckets as "profiler overhead"); keep real (anonymous) app functions
				f.category !== 'idle' &&
				f.category !== 'gc' &&
				f.category !== 'v8' &&
				f.category !== 'profiler'
		)
		.sort((a, b) => b.self_ms - a.self_ms);
	const LINES_PER_FN = 8;
	const lines_of = (key: string): { line: number; ms: number }[] | undefined => {
		const m = line_us.get(key);
		if (!m) return undefined;
		const list = [...m]
			.map(([line, us]) => ({ line, ms: round2(us / 1000) }))
			.filter((l) => l.ms > 0)
			.sort((a, b) => b.ms - a.ms)
			.slice(0, LINES_PER_FN);
		return list.length ? list : undefined;
	};
	for (const [i, f] of functions.entries()) {
		f.self_ms = round2(f.self_ms);
		f.total_ms = round2(f.total_ms);
		// the rows a report shows (80) plus headroom for a re-sort by total
		if (i < 120) {
			f.stacks = stacks_of(f.key);
			f.lines = lines_of(f.key);
		}
	}

	// --- per-run component time (page mode) --------------------------------
	// Each run is a window on the perf clock; every sample inside one credits its delta to every
	// component on its stack (once each), so a component's `runs_ms` is its inclusive time per run.
	const run_us = new Map<string, number[]>();
	const runs = timeline_input?.runs;
	// the profiler's own CPU INSIDE each run (its wrappers, its reads): what a run's wall time
	// carries that the app would not have paid — the report takes exactly this out, per run
	const overhead_run_us: number[] = runs ? new Array(runs.length).fill(0) : [];
	if (runs?.length && samples.length && deltas.length) {
		let t_us = profile.startTime;
		let ri = 0;
		const comps_on_stack = new Map<number, string[]>();
		const comps_of = (id: number): string[] => {
			const hit = comps_on_stack.get(id);
			if (hit) return hit;
			const out: string[] = [];
			let cur: number | undefined = id;
			while (cur !== undefined) {
				const rr = resolved.get(cur)!;
				if (rr.category === 'component' && !out.includes(rr.key)) out.push(rr.key);
				cur = parent_of.get(cur);
			}
			comps_on_stack.set(id, out);
			return out;
		};
		for (let i = 0; i < samples.length; i++) {
			const d = deltas[i] ?? 0;
			t_us += d;
			if (d <= 0) continue;
			const t = timeline_input!.perf_start + (t_us - profile.startTime) / 1000;
			while (ri < runs.length && t > runs[ri].end) ri++;
			if (ri >= runs.length) break;
			if (t < runs[ri].start) continue;
			if (resolved.get(samples[i])?.category === 'profiler') overhead_run_us[ri] += d;
			for (const key of comps_of(samples[i])) {
				let arr = run_us.get(key);
				if (!arr) run_us.set(key, (arr = new Array(runs.length).fill(0)));
				arr[ri] += d;
			}
		}
	}

	const components = [...agg.values()]
		.filter((f) => f.category === 'component' && f.total_ms >= 0.01)
		.sort((a, b) => b.total_ms - a.total_ms)
		.map((f) => {
			let parent: string | undefined;
			let best = 0;
			for (const [p, us] of parent_us.get(f.key) ?? []) {
				if (us > best) {
					best = us;
					parent = agg.get(p)?.name;
				}
			}
			const per_run = run_us.get(f.key);
			return {
				...f,
				self_ms: round2(f.self_ms),
				total_ms: round2(f.total_ms),
				stacks: f.stacks ?? stacks_of(f.key),
				lines: f.lines ?? lines_of(f.key),
				markup_ms: round2((markup_us.get(f.key) ?? 0) / 1000),
				logic_ms: round2((logic_us.get(f.key) ?? 0) / 1000),
				...(parent ? { parent } : {}),
				...(per_run ? { runs_ms: per_run.map((us) => round2(us / 1000)) } : {})
			};
		});

	const file_list = [...files.values()].sort((a, b) => b.self_ms - a.self_ms);
	for (const f of file_list) f.self_ms = round2(f.self_ms);

	const bucket_list = [...buckets.values()].sort((a, b) => b.self_ms - a.self_ms);
	for (const b of bucket_list) b.self_ms = round2(b.self_ms);

	// --- PATHS: the hot functions grouped by the caller they share -----------------------------
	// For every node of a hot function walk up to the root and credit that node's self time to each
	// ancestor of yours (a component or an app function; never a route root, which trivially
	// contains everything). A caller that covers two or more hot functions is a path; greedy: the
	// caller covering the most time wins, the deepest of the near-equal ones (the most specific
	// place to fix), its functions are taken, repeat.
	const HOT_FOR_PATHS = 40;
	const ROOT_NAME_RE = /^(?:_(?:page|layout|error)|Root|children|handle|respond|render_response|render_page)$/;
	// an app frame that only exists in a built chunk (no sourcemap reached it) is framework glue as
	// far as "a place to fix" goes: Kit's `children`, an adapter's `respond`
	const BUILT_CHUNK_RE = /\/(?:chunks|output|\.svelte-kit)\//;
	// Svelte's renderer glue is never a hot function worth a path of its own
	const SVELTE_GLUE_RE = /^(?:child|component|each|push|pop|head|slot|snippet|render)$/;
	/** the profiler's own wrapper frames, by name, for a build that bundled span.ts into the app chunk */
	const PROFILER_WRAPPER_RE = /^(?:span|within|wrapped|wrap_call)$/;
	// the hot set: the hottest functions overall, AND the hottest of the app's own — a dependency
	// with a hundred hot internals (a design system's renderer) must not crowd the app's functions
	// out of the paths, which are about the app's code to fix
	const not_glue = functions.filter((f) => !(f.category === 'svelte' && SVELTE_GLUE_RE.test(f.name)));
	const hot_keys = new Set([...not_glue.slice(0, HOT_FOR_PATHS).map((f) => f.key), ...not_glue.filter((f) => f.category === 'app' || f.category === 'component').slice(0, HOT_FOR_PATHS).map((f) => f.key)]);
	// an owner is a NAMED place to fix: never an anonymous arrow (its named parent owns instead)
	const can_own = (a: Resolved) =>
		!ROOT_NAME_RE.test(a.name) &&
		!a.name.startsWith('(') &&
		!a.name.endsWith('(island host)') &&
		(a.category === 'component' || (a.category === 'app' && !BUILT_CHUNK_RE.test(a.url)));
	const cover = new Map<string, Map<string, number>>(); // ancestor key → hot key → µs
	/** the hot nodes (every node of a hot key with self time), for the trees below */
	const hot_nodes: { id: number; key: string; us: number }[] = [];
	for (const n of profile.nodes) {
		const r = resolved.get(n.id)!;
		if (!hot_keys.has(r.key)) continue;
		const s = self_us.get(n.id) ?? 0;
		if (s <= 0) continue;
		hot_nodes.push({ id: n.id, key: r.key, us: s });
		const seen = new Set<string>([r.key]);
		let cur = parent_of.get(n.id);
		while (cur !== undefined) {
			const a = resolved.get(cur)!;
			// (an island host wrapper is ogygia's glue, not a place to fix: its island is)
			if (can_own(a) && !seen.has(a.key)) {
				seen.add(a.key);
				let m = cover.get(a.key);
				if (!m) cover.set(a.key, (m = new Map()));
				m.set(r.key, (m.get(r.key) ?? 0) + s);
			}
			cur = parent_of.get(cur);
		}
	}
	/** THE PATH TREE of one owner: for every hot node under an owner node, the chain of frames
	 *  from the owner down to it (pseudo frames dropped, a run of the same key folded), merged into
	 *  one tree with the hot self time accumulated along it. Wide fan-outs are capped per node. */
	const TREE_DEPTH = 10;
	const TREE_FANOUT = 6;
	/** an anonymous function reads by where it is (`fn @ ds-ssr.ts:46`), everything else by name */
	// an anonymous function (an arrow, a callback) has no name to show: the label is its file and
	// line, and the source line itself when the source is on this machine — `fn @ ds-ssr.ts:42 ·
	// tags.map(async (tag) => {` says what it is
	const path_label = (name: string, url: string, line: number, path?: string) => {
		if (!name.startsWith('(') || !url) return name;
		const file = url.split('/').pop()?.split('?')[0] ?? url;
		const snippet = resolver?.line_at_source(path ?? clean_url(url), line);
		return snippet ? `fn @ ${file}:${line} · ${snippet}` : `fn @ ${file}:${line}`;
	};
	const build_tree = (owner_key: string, fn_keys: Set<string>): PathNode => {
		const o = agg.get(owner_key)!;
		const root: PathNode = { key: o.key, name: o.name, category: o.category, file: o.url ? `${o.url}:${o.line}` : '', ms: 0, hot: hot_keys.has(o.key), calls: o.calls ?? null, children: [] };
		const node_of = (parent: PathNode, r: Resolved): PathNode => {
			let c = parent.children.find((x) => x.key === r.key);
			if (!c) {
				c = { key: r.key, name: path_label(r.name, r.url, r.line), category: r.category, file: r.url ? `${short_path(r.url)}:${r.line}` : '', ms: 0, hot: hot_keys.has(r.key), calls: agg.get(r.key)?.calls ?? null, children: [] };
				parent.children.push(c);
			}
			return c;
		};
		for (const h of hot_nodes) {
			if (!fn_keys.has(h.key)) continue;
			// the chain up to the nearest owner node
			const chain: Resolved[] = [];
			let cur: number | undefined = h.id;
			let found = false;
			while (cur !== undefined && chain.length < 64) {
				const r = resolved.get(cur)!;
				if (r.key === owner_key && cur !== h.id) {
					found = true;
					break;
				}
				// the chain keeps your frames and the hot ones: Svelte's own glue between them (`child`,
				// `component`, `each`) and pseudo frames are dropped, so a component's wrapper + body
				// (see frames_above) fall together and fold into one
				// (the profiler's own wrappers — `span`, `within`, an `instrument`ed call — are glue too;
				// an anonymous frame stays only when it is itself hot: it is then named by its location)
				const glue =
					r.category === 'profiler' ||
					((r.name.startsWith('(') || r.category === 'svelte' || r.name === 'Region' || PROFILER_WRAPPER_RE.test(r.name)) && !hot_keys.has(r.key));
				if (!glue && (chain.length === 0 || chain[chain.length - 1].key !== r.key)) chain.push(r);
				cur = parent_of.get(cur);
			}
			if (!found) continue;
			chain.reverse(); // owner's child first
			const us = h.us;
			root.ms += us;
			let at = root;
			for (const r of chain.slice(-TREE_DEPTH)) {
				at = node_of(at, r);
				at.ms += us;
			}
		}
		const finish = (n: PathNode) => {
			n.ms = round2(n.ms / 1000);
			n.children.sort((x, y) => y.ms - x.ms);
			if (n.children.length > TREE_FANOUT) {
				const rest = n.children.slice(TREE_FANOUT);
				n.children = n.children.slice(0, TREE_FANOUT);
				n.children.push({ key: '', name: `(${rest.length} more)`, category: 'unknown', file: '', ms: round2(rest.reduce((t, c) => t + c.ms, 0) / 1000), hot: false, children: [] });
			}
			for (const c of n.children) if (c.key) finish(c);
		};
		finish(root);
		return root;
	};
	const paths: PathGroup[] = [];
	const taken = new Set<string>();
	// a group is worth a path from 1% of busy (a page whose busy is mostly one dependency still
	// gets its own code's paths)
	const min_path_us = Math.max(2000, busy_us * 0.01);
	for (let round = 0; round < 5; round++) {
		let best: { key: string; us: number; fns: [string, number][] } | null = null;
		const scored: { key: string; us: number; fns: [string, number][] }[] = [];
		for (const [ak, m] of cover) {
			if (taken.has(ak)) continue;
			const fns = [...m].filter(([hk]) => !taken.has(hk));
			if (fns.length < 2) continue;
			const us = fns.reduce((t, [, v]) => t + v, 0);
			if (us < min_path_us) continue;
			scored.push({ key: ak, us, fns });
		}
		if (!scored.length) break;
		scored.sort((x, y) => y.us - x.us);
		// THE MOST SPECIFIC PLACE: the top candidate is often a frame near the root (the layout's
		// `children`, the page) that holds everything. Walk its path tree DOWN while one branch
		// keeps most of the time (≥ 75%), through the roots and the island hosts, and stop at the
		// deepest frame that is itself a candidate (a component or app function with two or more
		// hot functions under it). That is the caller to fix.
		best = scored[0];
		const by_key = new Map(scored.map((c) => [c.key, c]));
		let node = build_tree(best.key, new Set(best.fns.map(([hk]) => hk)));
		for (let depth = 0; depth < 12; depth++) {
			const c = node.children[0];
			// descend only while one branch holds nearly everything (≥ 90%): a component whose hot
			// functions split across two helpers stays the owner, with the whole tree under it
			if (!c || !c.key || c.ms < node.ms * 0.9) break;
			// an anonymous frame (an arrow inside a named function) is not a place to fix: the
			// descent stops at its named parent, the owner the report can point at
			if (c.name.startsWith('(')) break;
			node = c;
			const cand = by_key.get(c.key);
			if (cand) best = cand;
		}
		const owner = agg.get(best.key);
		if (!owner) break;
		taken.add(best.key);
		for (const [hk] of best.fns) taken.add(hk);
		const fns = best.fns
			.map(([hk, us]) => {
				const f = agg.get(hk)!;
				return { key: hk, name: path_label(f.name, f.url, f.line, f.path), url: f.url, line: f.line, category: f.category, pkg: f.pkg, ms: round2(us / 1000) };
			})
			.sort((x, y) => y.ms - x.ms);
		paths.push({
			owner: { key: owner.key, name: owner.name, url: owner.url, line: owner.line, category: owner.category, total_ms: round2(owner.total_ms), calls: owner.calls },
			fns,
			ms: round2(best.us / 1000),
			share: owner.total_ms > 0 ? round2(Math.min(1, best.us / 1000 / owner.total_ms)) : 0,
			tree: build_tree(best.key, new Set(best.fns.map(([hk]) => hk)))
		});
	}

	// --- the request timeline (critical path + phases), from the same frame table ---------
	const timeline = timeline_input
		? build_timeline(
				profile,
				(id) => {
					const r = resolved.get(id)!;
					return { name: r.name, url: r.url, line: r.line, category: r.category, pkg: r.pkg };
				},
				(id) => parent_of.get(id),
				timeline_input
			)
		: undefined;
	// the CPU over the WHOLE capture (every run), on the capture's clock — one more cheap pass of
	// the same builder with a window that is the entire profile; only its segments are kept
	const capture_cpu = timeline_input?.runs?.length
		? build_timeline(
				profile,
				(id) => {
					const r = resolved.get(id)!;
					return { name: r.name, url: r.url, line: r.line, category: r.category, pkg: r.pkg };
				},
				(id) => parent_of.get(id),
				{ perf_start: timeline_input.perf_start, window: { start: timeline_input.perf_start, end: timeline_input.perf_start + (profile.endTime - profile.startTime) / 1000 }, calls: [] }
			)
				.segments.filter((s) => s.kind === 'cpu')
				.map((s) => ({ t0: s.t0, t1: s.t1, label: s.label, category: s.category, ...(s.file ? { file: s.file } : {}) }))
		: undefined;
	// the samples of the one window, with their stacks: the substrate (queried by the scrubber,
	// the render stepper, and anything that asks "what ran between t and t'")
	const stacks = timeline_input
		? build_stack_index(
				profile,
				(id) => {
					const r = resolved.get(id)!;
					return { name: r.name, url: r.url, line: r.line, category: r.category };
				},
				(id) => parent_of.get(id),
				timeline_input.perf_start,
				timeline_input.window
			)
		: undefined;

	return {
		duration_ms: round2((profile.endTime - profile.startTime) / 1000),
		busy_ms: round2(busy_us / 1000),
		idle_ms: round2(idle_us / 1000),
		gc_ms: round2(gc_us / 1000),
		overhead_ms: round2(overhead_us / 1000),
		overhead_functions,
		...(runs?.length ? { overhead_by_run_ms: overhead_run_us.map((us) => round2(us / 1000)) } : {}),
		...(capture_cpu ? { capture_cpu } : {}),
		deopts,
		sample_count: samples.length,
		functions,
		components,
		files: file_list,
		buckets: bucket_list,
		flame,
		sourcemapped: resolver?.hit ?? false,
		...(timeline ? { timeline } : {}),
		...(stacks ? { stacks } : {}),
		paths
	};
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// heap allocation sampling (inspector HeapProfiler.stopSampling output)

export interface HeapNode {
	callFrame: CallFrame;
	selfSize: number;
	children?: HeapNode[];
}

export interface HeapAllocator {
	name: string;
	url: string;
	line: number;
	category: FrameCategory;
	self_bytes: number;
	total_bytes: number;
}

/** Aggregate a sampled heap profile into "who allocates the most" rows. */
/** BYTES PER COMPONENT: every sampled allocation credited to the nearest component above it in
 *  the heap tree (the same rule as markup/logic: nested components take their own). */
/** A minified identifier: what a production client chunk calls its functions (`Y`, `Gr`, `_a`, `#u`). */
const MINIFIED_NAME_RE = /^#?[A-Za-z_$][A-Za-z0-9_$]?$/;

/**
 * The renamer for a BROWSER profile: a component confirmed in a minified client chunk (Svelte's
 * runtime is below it, so it is one, but its name is `Y`) is named after the `.svelte` files the
 * build put in that chunk — `ProductCard`, or `ProductCard (+2 in chunk)` when the chunk holds
 * several. `contents` is the build handoff's chunk summary by path (`chunkContents`). Only the
 * confirmed stage renames: an unconfirmed `Pt` is a helper and stays app code.
 */
export function chunk_component_renamer(contents: (path: string) => readonly string[] | null | undefined): (name: string, url: string, stage: 'frame' | 'confirmed') => string | undefined {
	const cache = new Map<string, string | undefined>();
	return (name, url, stage) => {
		if (stage !== 'confirmed' || !MINIFIED_NAME_RE.test(name)) return undefined;
		let path: string;
		try {
			path = new URL(url, 'http://x').pathname;
		} catch {
			return undefined;
		}
		if (!cache.has(path)) {
			const comps = (contents(path) ?? []).filter((s) => s.endsWith('.svelte')).map((s) => component_name_from_file(s) ?? s.split('/').pop()!.replace(/\.svelte$/, ''));
			cache.set(path, comps.length ? (comps.length === 1 ? comps[0] : `${comps[0]} (+${comps.length - 1} in chunk)`) : undefined);
		}
		return cache.get(path);
	};
}

export function heap_by_component(head: HeapNode, limit = 60): { name: string; bytes: number }[] {
	const by = new Map<string, number>();
	const stack: string[] = [];
	const visit = (node: HeapNode): void => {
		const f = node.callFrame;
		const c = categorize(f);
		let name = f.functionName;
		if (c.category === 'component') name = strip_bundler_suffix(name);
		else if ((!f.functionName || f.functionName === '(anonymous)') && c.category !== 'dependency') {
			// an inline region of a component's own file: its component
			const derived = component_name_from_file(clean_url(f.url));
			if (derived) name = derived;
		}
		const is_comp = c.category === 'component' || (name !== f.functionName && !!name);
		if (is_comp) stack.push(name);
		const near = stack[stack.length - 1];
		if (near !== undefined && node.selfSize > 0) by.set(near, (by.get(near) ?? 0) + node.selfSize);
		for (const ch of node.children ?? []) visit(ch);
		if (is_comp) stack.pop();
	};
	visit(head);
	return [...by.entries()]
		.map(([name, bytes]) => ({ name, bytes }))
		.sort((a, b) => b.bytes - a.bytes)
		.slice(0, limit);
}

export function analyze_heap(head: HeapNode, limit = 25): HeapAllocator[] {
	const agg = new Map<string, HeapAllocator>();
	const visit = (node: HeapNode): number => {
		const f = node.callFrame;
		const key = `${f.functionName} ${f.url}`;
		let stat = agg.get(key);
		if (!stat) {
			stat = {
				name: f.functionName || '(anonymous)',
				url: short_path(f.url),
				line: f.lineNumber + 1,
				category: categorize(f).category,
				self_bytes: 0,
				total_bytes: 0
			};
			agg.set(key, stat);
		}
		stat.self_bytes += node.selfSize;
		let total = node.selfSize;
		for (const c of node.children ?? []) total += visit(c);
		// note: recursion double-counts total_bytes for self-recursive frames;
		// acceptable for a "top allocators" table sorted by self
		stat.total_bytes += total;
		return total;
	};
	visit(head);
	return [...agg.values()]
		.filter(
			(a) =>
				a.self_bytes > 0 && a.category !== 'v8' && a.category !== 'gc' && a.category !== 'profiler'
		)
		.sort((a, b) => b.self_bytes - a.self_bytes)
		.slice(0, limit);
}
