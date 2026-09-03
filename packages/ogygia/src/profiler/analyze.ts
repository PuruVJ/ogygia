/**
 * Analysis of a raw V8 .cpuprofile into readable aggregates.
 *
 * Framework-blind: understands Svelte/SvelteKit/Vite conventions when it sees
 * them (a `.svelte` URL, a `node_modules` segment) but works on any Node
 * server profile. No imports from the rest of ogygia — this file plus
 * report.ts/index.ts can be dropped into any SvelteKit project.
 */

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

export interface FrameStat {
	name: string;
	url: string;
	line: number;
	category: FrameCategory;
	/** package name when category is 'dependency' */
	pkg?: string;
	/** ms spent exactly here */
	self_ms: number;
	/** ms spent here plus everything it called (recursion counted once) */
	total_ms: number;
	/** exact invocation count from V8 precise coverage, when available (this frame's own count) */
	calls?: number;
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
}

// ---------------------------------------------------------------------------
// categorization

const component_name_re = /^[A-Z][A-Za-z0-9_]*$/;
const ROUTE_FILE_FN_RE = /^_(page|layout|error)$/;
const SVELTE_BASENAME_RE = /([^/\\]+)\.svelte$/;
const SVELTE_MODULE_EXT_RE = /\.svelte\.[jt]s$/;

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
 * file's url but not a component-shaped name. */
const is_component_name = (name: string): boolean =>
	!handler_names.has(name) && (component_name_re.test(name) || ROUTE_FILE_FN_RE.test(name));

/** The component name a `.svelte` source file compiles to — used to name the
 * anonymous inline-code frame that V8 samples inside a component. Returns
 * undefined for non-component files. */
function component_name_from_file(url: string): string | undefined {
	const m = SVELTE_BASENAME_RE.exec(url);
	if (!m) return undefined;
	const base = m[1];
	if (base.startsWith('+')) {
		const kind = base.slice(1);
		return kind === 'page' || kind === 'layout' || kind === 'error' ? `_${kind}` : undefined;
	}
	return component_name_re.test(base) ? base : undefined;
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
	if (url.includes('/ogygia/src/profiler/') || url.includes('/ogygia/dist/profiler/')) {
		return { category: 'profiler' };
	}

	const pkg = package_of(url);
	if (pkg === 'svelte') return { category: 'svelte', pkg };
	if (pkg) return { category: 'dependency', pkg };

	if (url.endsWith('.svelte') || SVELTE_MODULE_EXT_RE.test(url)) {
		// only the file's root render function is "the component" — inner
		// closures share the url but land in app code
		return { category: is_component_name(name) ? 'component' : 'app' };
	}
	if (url) {
		// bundled server output: URLs point at chunks, but Svelte names the SSR
		// function after the component file, so a component-shaped name is our
		// best signal for "this is a component"
		if (is_component_name(name)) return { category: 'component' };
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
	/** generated column -> [column, source index, original line, name index (-1 = none)] */
	cols: [number, number, number, number][];
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
				cur.cols.push([col, src, src_line, name_idx]);
			} else {
				cur.cols.push([col, src, src_line, -1]);
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

	/** map a generated (url, line0, col0) to the original file/line, plus the
	 * original identifier at that position when the map carries `names` — that's
	 * what turns a bundled `(anonymous)` back into a real name */
	resolve(
		url: string,
		line: number,
		column: number
	): { source: string; line: number; name?: string } | undefined {
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
		return { source, line: m[2] + 1, name: m[3] >= 0 ? entry.names[m[3]] : undefined };
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
	call_counts?: Record<string, number>
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
		category: FrameCategory;
		pkg?: string;
	}
	const resolved = new Map<number, Resolved>();
	for (const n of profile.nodes) {
		const f = n.callFrame;
		let url = f.url;
		let line = f.lineNumber + 1;
		let name = display_name(f);
		let cat = categorize(f);
		if (resolver && (cat.category === 'app' || cat.category === 'component')) {
			const mapped = resolver.resolve(f.url, f.lineNumber, f.columnNumber);
			if (mapped) {
				url = mapped.source;
				line = mapped.line;
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
		if (!f.functionName || f.functionName === '(anonymous)') {
			const derived = component_name_from_file(clean_url(url));
			if (derived) {
				name = derived;
				cat = { category: 'component' };
			}
		}
		// Components are keyed by name alone: Svelte bundles every component in a
		// route into one chunk, so the wrapper frame's url (…/_page.svelte.js) and
		// the sourcemapped inline frame's url (…/Foo.svelte) differ for the SAME
		// component. Name-keying merges them; other frames keep name+url.
		const key = cat.category === 'component' ? `C:${name}` : `${name} ${url}`;
		resolved.set(n.id, {
			key,
			name,
			url,
			line,
			category: cat.category,
			pkg: cat.pkg
		});
		// Join this frame's invocation count from coverage, on the RAW identity (pre-sourcemap name+url).
		// A component key merges several raw frames (the named wrapper + anonymous inline regions) — only
		// the wrapper, whose raw name IS the component name, carries the render count; the inline loop's
		// own count would misreport it. Set once per key (the same function has one true count).
		if (call_counts && !calls_by_key.has(key)) {
			const c = call_counts[(f.functionName || '') + '\0' + f.url];
			if (c && (cat.category !== 'component' || f.functionName === name)) {
				calls_by_key.set(key, c);
			}
		}
	}

	// --- roots -------------------------------------------------------------
	const has_parent = new Set<number>();
	for (const n of profile.nodes) for (const c of n.children ?? []) has_parent.add(c);
	const roots = profile.nodes.filter((n) => !has_parent.has(n.id));

	// --- aggregate: self + (recursion-safe) total per function key ---------
	const agg = new Map<string, FrameStat>();
	const files = new Map<string, GroupStat>();
	const buckets = new Map<string, GroupStat>();
	let idle_us = 0;
	let gc_us = 0;
	let busy_us = 0;

	const path = new Map<string, number>(); // key -> occurrences on current stack

	const visit = (node: ProfileNode) => {
		const r = resolved.get(node.id)!;
		const s = self_us.get(node.id) ?? 0;

		path.set(r.key, (path.get(r.key) ?? 0) + 1);

		let stat = agg.get(r.key);
		if (!stat) {
			stat = {
				name: r.name,
				url: short_path(r.url),
				line: r.line,
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
			stat.line = r.line;
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

		for (const c of node.children ?? []) {
			const child = by_id.get(c);
			if (child) visit(child);
		}

		const left = path.get(r.key)! - 1;
		if (left === 0) path.delete(r.key);
		else path.set(r.key, left);
	};
	// iterative safety: profiles can nest deeply, but V8 stacks max out well
	// below JS recursion limits, so plain recursion holds
	for (const root of roots) visit(root);

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
	for (const f of functions) {
		f.self_ms = round2(f.self_ms);
		f.total_ms = round2(f.total_ms);
	}

	const components = [...agg.values()]
		.filter((f) => f.category === 'component' && f.total_ms >= 0.01)
		.sort((a, b) => b.total_ms - a.total_ms)
		.map((f) => ({ ...f, self_ms: round2(f.self_ms), total_ms: round2(f.total_ms) }));

	const file_list = [...files.values()].sort((a, b) => b.self_ms - a.self_ms);
	for (const f of file_list) f.self_ms = round2(f.self_ms);

	const bucket_list = [...buckets.values()].sort((a, b) => b.self_ms - a.self_ms);
	for (const b of bucket_list) b.self_ms = round2(b.self_ms);

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
		sourcemapped: resolver?.hit ?? false
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
		.filter((a) => a.self_bytes > 0 && a.category !== 'v8' && a.category !== 'gc')
		.sort((a, b) => b.self_bytes - a.self_bytes)
		.slice(0, limit);
}
