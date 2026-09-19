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

export interface Analysis {
	/** wall-clock length of the recording window in ms */
	duration_ms: number;
	/** ms the CPU was running JS/GC (everything except idle) */
	busy_ms: number;
	idle_ms: number;
	gc_ms: number;
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
}

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

function clean_url(url: string): string {
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
export class SourceMapResolver {
	/** whether any lookup succeeded */
	hit = false;
	readonly #read: (path: string) => string | undefined;
	readonly #cache = new Map<
		string,
		{ lines: MappedLine[]; sources: string[]; names: string[] } | null
	>();

	constructor(read: (path: string) => string | undefined) {
		this.#read = read;
	}

	/** map a generated (url, line0, col0) to the original file/line/column (1-based), plus the
	 * original identifier at that position when the map carries `names` — that's
	 * what turns a bundled `(anonymous)` back into a real name */
	resolve(
		url: string,
		line: number,
		column: number
	): { source: string; line: number; column: number; name?: string } | undefined {
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
		return {
			source: join_source(path, source),
			line: m[2] + 1,
			column: (m[4] ?? 0) + 1,
			name: m[3] >= 0 ? entry.names[m[3]] : undefined
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
	timeline_input?: TimelineInput
): Analysis {
	// Invocation count per FRAME KEY, joined from coverage by the raw `<functionName>\0<url>` identity
	// (the same key #count_calls emits). Filled during the resolve loop, read when a FrameStat is created.
	const calls_by_key = new Map<string, number>();
	const by_id = new Map<number, ProfileNode>();
	for (const n of profile.nodes) by_id.set(n.id, n);

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
	for (const n of profile.nodes) {
		const f = n.callFrame;
		let url = f.url;
		let line = f.lineNumber + 1;
		let col = f.columnNumber + 1;
		let name = display_name(f);
		let cat = categorize(f);
		if (resolver && (cat.category === 'app' || cat.category === 'component')) {
			const mapped = resolver.resolve(f.url, f.lineNumber, f.columnNumber);
			if (mapped) {
				url = mapped.source;
				line = mapped.line;
				col = mapped.column;
				// a bundled anonymous frame often has a real name in the source —
				// the map's `names` entry at the function position recovers it
				if (!f.functionName && mapped.name) name = mapped.name;
				// re-categorize with the true file and the recovered name
				cat = categorize({
					...f,
					functionName: f.functionName || mapped.name || '',
					url: mapped.source
				});
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
	const frames_above = (id: number): CallStack['frames'] => {
		const frames: CallStack['frames'] = [];
		let cur = parent_of.get(id);
		while (cur !== undefined && frames.length < STACK_DEPTH) {
			const r = resolved.get(cur)!;
			if (!r.name.startsWith('(')) {
				frames.push({
					n: r.name,
					f: r.url ? `${short_path(r.url)}:${r.line}` : '',
					c: r.category
				});
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

	// --- final tables ------------------------------------------------------
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
	for (const [i, f] of functions.entries()) {
		f.self_ms = round2(f.self_ms);
		f.total_ms = round2(f.total_ms);
		// the rows a report shows (80) plus headroom for a re-sort by total
		if (i < 120) f.stacks = stacks_of(f.key);
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
			return {
				...f,
				self_ms: round2(f.self_ms),
				total_ms: round2(f.total_ms),
				stacks: f.stacks ?? stacks_of(f.key),
				markup_ms: round2((markup_us.get(f.key) ?? 0) / 1000),
				logic_ms: round2((logic_us.get(f.key) ?? 0) / 1000),
				...(parent ? { parent } : {})
			};
		});

	const file_list = [...files.values()].sort((a, b) => b.self_ms - a.self_ms);
	for (const f of file_list) f.self_ms = round2(f.self_ms);

	const bucket_list = [...buckets.values()].sort((a, b) => b.self_ms - a.self_ms);
	for (const b of bucket_list) b.self_ms = round2(b.self_ms);

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

	return {
		duration_ms: round2((profile.endTime - profile.startTime) / 1000),
		busy_ms: round2(busy_us / 1000),
		idle_ms: round2(idle_us / 1000),
		gc_ms: round2(gc_us / 1000),
		sample_count: samples.length,
		functions,
		components,
		files: file_list,
		buckets: bucket_list,
		flame,
		sourcemapped: resolver?.hit ?? false,
		...(timeline ? { timeline } : {})
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
