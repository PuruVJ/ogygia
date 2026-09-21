/**
 * WHO CAUSED THE GC — each pause joined to the allocations that filled the heap before it.
 *
 * V8's sampling heap profiler, asked to include objects already collected, counts every sampled
 * allocation whether it survived or not — the allocation stream that drives the collector. The
 * recorder reads that profile every few tens of milliseconds while the window runs; the
 * difference between two reads is what was allocated in between, by stack. A minor GC (a
 * scavenge) fires when the young space fills, so the allocations since the previous pause caused
 * it; a major GC fires when the old space grows, so the allocations since the previous major
 * pause (their survivors were promoted) caused that one. Each pause gets its top allocators, each
 * allocator gets the pause time it is responsible for, and the report can say "this 40 ms of GC
 * is toProductVM's structuredClone in ProductCard", which no table of allocators can. Pure.
 */
import { categorize, clean_url, component_name_from_file, strip_bundler_suffix, type FrameCategory, type HeapNode } from './analyze.js';

export interface GcEvent {
	/** ms on the profile's clock (from the window's start) */
	t: number;
	ms: number;
	kind: 'minor' | 'major' | 'incremental' | 'weak' | 'other';
	/** Node's GC flags (forced, all available garbage, …) */
	flags: number;
}

/** one sampled allocation site: a stack, keyed by a hash of the frames above it */
export interface AllocSite {
	key: string;
	name: string;
	url: string;
	line: number;
	category: FrameCategory;
	/** the nearest component on the stack, when one is there */
	component: string | null;
	/** the nearest app frame above, formatted: `toProductVM (lib/mappers.ts:11)` */
	caller?: string;
	/** …and its raw parts, so a source map can rename the file and line afterwards */
	caller_name?: string;
	caller_url?: string;
	caller_line?: number;
}

export interface AllocSlice {
	t0: number;
	t1: number;
	/** bytes allocated in the slice, per site key (only sites that allocated) */
	bytes: Record<string, number>;
}

export interface GcPause {
	t: number;
	/** the pause AS THE APP WOULD HAVE PAID IT: the measured length minus the profiler's own share
	 *  of the allocations that filled the heap before it */
	ms: number;
	/** the length the observer measured, before that share was taken out */
	ms_measured: number;
	kind: GcEvent['kind'];
	forced: boolean;
	/** ms since the pause this one is charged from */
	since_ms: number;
	/** bytes allocated in that stretch — measured when the window was read in slices, else the
	 *  window's average rate over the stretch (`estimated`) */
	allocated: number;
	estimated?: boolean;
	why: string;
	/** the allocators of that stretch (only when the window was read in slices) */
	top: { key: string; name: string; component: string | null; bytes: number; share: number }[];
	/** what the CPU was running when the pause fell (the timeline's segment at that moment) */
	running?: { label: string; category: string; file?: string };
}

export interface GcMaker {
	key: string;
	name: string;
	url: string;
	line: number;
	category: FrameCategory;
	component: string | null;
	caller?: string;
	allocated: number;
	/** share of everything allocated in the window */
	share: number;
	/** pause time attributed to it, by its share of each pause's cause */
	gc_ms: number;
	/** pauses where it was among the top three causes */
	pauses: number;
}

export interface GcAttribution {
	summary: {
		count: number;
		/** pause time as the app would have paid it (the profiler's share taken out) */
		total_ms: number;
		max_ms: number;
		/** what the observer measured, and the part of it that was the profiler's own garbage */
		measured_ms: number;
		overhead_ms: number;
		minor: number;
		major: number;
		incremental: number;
		weak: number;
		allocated_mb: number;
		alloc_rate_mb_s: number;
		/** heap still held at the end against the start, when the host measured it */
		retained_mb?: number;
		/** slices read (the attribution's resolution) and their typical length */
		slices: number;
		slice_ms: number;
	};
	pauses: GcPause[];
	makers: GcMaker[];
	/** components by pause time attributed to their allocations */
	components: { name: string; allocated: number; gc_ms: number }[];
	/** the profiled request's window starts this many ms into the capture (pause times are on the
	 *  capture's clock; the timeline's is the window's) */
	window_offset_ms?: number;
}

// Node's GC kinds (perf_hooks.constants)
const GC_MINOR = 1;
const GC_MAJOR = 4;
const GC_INCREMENTAL = 8;
const GC_WEAKCB = 16;
const GC_FLAGS_FORCED = 4;

export function gc_kind(kind: number): GcEvent['kind'] {
	if (kind & GC_MAJOR) return 'major';
	if (kind & GC_MINOR) return 'minor';
	if (kind & GC_INCREMENTAL) return 'incremental';
	if (kind & GC_WEAKCB) return 'weak';
	return 'other';
}

/** FNV-1a over a string, hex — a short stable key for a stack path */
function fnv(s: string, seed = 0x811c9dc5): number {
	let h = seed;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

/** The sampling profile flattened to allocation sites: every node with self bytes, keyed by the
 *  hash of its stack, with its cumulative self bytes. `dict` collects what each key is. */
export function heap_sites(head: HeapNode, dict: Record<string, AllocSite>): Map<string, number> {
	const out = new Map<string, number>();
	const stack: string[] = [];
	const short = (url: string) => clean_url(url).split('/').slice(-2).join('/');
	// `caller`: the nearest frame ABOVE that is the app's own code (a builtin like `replace` or
	// `map` allocates on behalf of the app line that called it — that line is the useful name)
	const visit = (node: HeapNode, parent_hash: number, app_above: { name: string; url: string; line: number } | undefined): void => {
		const f = node.callFrame;
		const cat = categorize(f);
		let name = f.functionName || '(anonymous)';
		let is_comp = cat.category === 'component';
		if (is_comp) name = strip_bundler_suffix(name);
		else if ((!f.functionName || f.functionName === '(anonymous)') && cat.category !== 'dependency') {
			const derived = component_name_from_file(clean_url(f.url));
			if (derived) {
				name = derived;
				is_comp = true;
			}
		}
		const h = fnv(`${name}|${f.url}|${f.lineNumber}`, parent_hash);
		const key = h.toString(16).padStart(8, '0');
		if (is_comp) stack.push(name);
		const category: FrameCategory = is_comp ? 'component' : cat.category;
		if (node.selfSize > 0) {
			out.set(key, (out.get(key) ?? 0) + node.selfSize);
			if (!dict[key])
				dict[key] = {
					key,
					name,
					url: f.url,
					line: f.lineNumber + 1,
					category,
					component: stack[stack.length - 1] ?? null,
					...(app_above ? { caller: `${app_above.name} (${short(app_above.url)}:${app_above.line})`, caller_name: app_above.name, caller_url: app_above.url, caller_line: app_above.line } : {})
				};
		}
		const own = (category === 'app' || category === 'component' || category === 'dependency') && f.url ? { name, url: f.url, line: f.lineNumber + 1 } : app_above;
		for (const ch of node.children ?? []) visit(ch, h, own);
		if (is_comp) stack.pop();
	};
	visit(head, 0x811c9dc5, undefined);
	return out;
}

/** What was allocated between two reads: per site, the growth of its cumulative bytes. */
export function slice_delta(prev: Map<string, number>, cur: Map<string, number>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [k, v] of cur) {
		const d = v - (prev.get(k) ?? 0);
		if (d > 0) out[k] = d;
	}
	return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const mb = (b: number) => r1(b / 1048576);

export function attribute_gc(input: {
	slices: AllocSlice[];
	events: GcEvent[];
	dict: Record<string, AllocSite>;
	window_ms: number;
	retained_mb?: number;
	/** the CPU timeline's segments on the same clock as the events: what was running at each pause */
	running?: { t0: number; t1: number; label: string; category: string; file?: string }[];
}): GcAttribution {
	const { slices, dict } = input;
	const events = [...input.events].sort((a, b) => a.t - b.t);
	// one read over the whole window: a pause's stretch is charged at the window's average rate
	const single = slices.length === 1;
	// what was running when the pause fell: the segment at that moment — but the moment itself is
	// the collector's, so the answer is the last piece of the app's own work before it
	const running_at = (t: number) => {
		const segs = input.running ?? [];
		let best: (typeof segs)[number] | undefined;
		for (const s of segs) {
			if (s.category === 'gc' || s.category === 'idle' || s.category === 'profiler') continue;
			if (s.t0 <= t && t <= s.t1) return s;
			if (s.t1 <= t && (!best || s.t1 > best.t1)) best = s;
		}
		return best && t - best.t1 <= 50 ? best : undefined;
	};
	// the runtime's own allocations (the V8 API, the collector) are nobody's fault; the PROFILER's
	// own (its reads of this very profile, its stack captures) are its fault and are taken out of
	// every pause as its share of what filled the heap
	const ours = (k: string) => {
		const c = dict[k]?.category;
		return c !== 'v8' && c !== 'gc' && c !== 'profiler';
	};
	const profilers = (k: string) => dict[k]?.category === 'profiler';
	// one row per allocation LINE: the same builtin reached through different stacks (three
	// `replace` calls from one loop) is one maker, not three
	const ident_of = (k: string) => {
		const d = dict[k];
		return d ? `${d.name}|${d.url}|${d.line}|${d.caller ?? ''}|${d.component ?? ''}` : k;
	};
	const first_key: Record<string, string> = {};
	// bytes allocated over a stretch [from, to]: each read charged by how much of it the stretch
	// covers (a read is the resolution; a pause inside it gets that share of the read's bytes)
	const between = (from: number, to: number): { app: Record<string, number>; profiler_bytes: number } => {
		const acc: Record<string, number> = {};
		let profiler_bytes = 0;
		for (const s of slices) {
			const len = s.t1 - s.t0;
			if (len <= 0 || s.t1 <= from || s.t0 > to) continue;
			const w = Math.max(0, Math.min(1, (Math.min(s.t1, to) - Math.max(s.t0, from)) / len));
			if (!w) continue;
			for (const [k, b] of Object.entries(s.bytes)) {
				if (profilers(k)) {
					profiler_bytes += b * w;
					continue;
				}
				if (!ours(k)) continue;
				const id = ident_of(k);
				first_key[id] ??= k;
				acc[id] = (acc[id] ?? 0) + b * w;
			}
		}
		return { app: acc, profiler_bytes };
	};
	const total_by_key: Record<string, number> = {};
	for (const s of slices)
		for (const [k, b] of Object.entries(s.bytes)) {
			if (!ours(k)) continue;
			const id = ident_of(k);
			first_key[id] ??= k;
			total_by_key[id] = (total_by_key[id] ?? 0) + b;
		}
	const total_bytes = Object.values(total_by_key).reduce((a, b) => a + b, 0);
	const gc_ms_by_key: Record<string, number> = {};
	const top3_by_key: Record<string, number> = {};
	const pauses: GcPause[] = [];
	let last_any = 0;
	let last_major = 0;
	let measured_total = 0;
	let overhead_total = 0;
	for (const e of events) {
		const from = e.kind === 'major' ? last_major : last_any;
		const { app: cause, profiler_bytes } = between(from, e.t);
		const allocated = Object.values(cause).reduce((a, b) => a + b, 0);
		// the profiler's share of what filled the heap before this pause is its share of the pause
		const overhead_share = allocated + profiler_bytes > 0 ? profiler_bytes / (allocated + profiler_bytes) : 0;
		const ms_app = e.ms * (1 - overhead_share);
		measured_total += e.ms;
		overhead_total += e.ms - ms_app;
		const forced = (e.flags & GC_FLAGS_FORCED) !== 0;
		const top = single
			? []
			: Object.entries(cause)
					.sort((a, b) => b[1] - a[1])
					.slice(0, 5)
					.map(([id, bytes]) => {
						const d = dict[first_key[id]];
						return { key: first_key[id], name: d?.name ?? id, component: d?.component ?? null, bytes: Math.round(bytes), share: allocated ? r2(bytes / allocated) : 0 };
					});
		for (const [key, bytes] of Object.entries(cause)) gc_ms_by_key[key] = (gc_ms_by_key[key] ?? 0) + (allocated ? (bytes / allocated) * ms_app : 0);
		for (const t of top.slice(0, 3)) top3_by_key[ident_of(t.key)] = (top3_by_key[ident_of(t.key)] ?? 0) + 1;
		const since_ms = r1(e.t - from);
		const run = running_at(e.t);
		const about = single ? '≈' : '';
		let why: string;
		if (forced) why = 'forced (something asked for a collection: the inspector, a gc() call, a low-memory signal)';
		else if (!allocated) why = e.kind === 'major' ? 'the old space was full; nothing sampled was allocated since the last major pause (the pressure came from before the window)' : 'nothing sampled was allocated since the last pause (an allocation the sampler missed, or pressure from before the window)';
		else if (e.kind === 'minor') why = `the young space filled: ${about}${mb(allocated)} MB allocated in the ${since_ms} ms since the last pause`;
		else if (e.kind === 'major') why = `the old space grew: ${about}${mb(allocated)} MB allocated since the last major pause, and what survived the minor ones was promoted into it`;
		else if (e.kind === 'incremental') why = `an incremental marking step of a major collection (${about}${mb(allocated)} MB allocated since the last pause)`;
		else why = `a weak-callback pass (${about}${mb(allocated)} MB allocated since the last pause)`;
		pauses.push({ t: r1(e.t), ms: r2(ms_app), ms_measured: r2(e.ms), kind: e.kind, forced, since_ms, allocated: Math.round(allocated), ...(single ? { estimated: true } : {}), why, top, ...(run ? { running: { label: run.label, category: run.category, ...(run.file ? { file: run.file } : {}) } } : {}) });
		last_any = e.t;
		if (e.kind === 'major') last_major = e.t;
	}
	const makers: GcMaker[] = Object.entries(total_by_key)
		.map(([id, allocated]) => {
			const key = first_key[id];
			const d = dict[key];
			return {
				key,
				name: d?.name ?? key,
				url: d?.url ?? '',
				line: d?.line ?? 0,
				category: d?.category ?? 'app',
				component: d?.component ?? null,
				...(d?.caller ? { caller: d.caller } : {}),
				allocated,
				share: total_bytes ? r2(allocated / total_bytes) : 0,
				gc_ms: r2(gc_ms_by_key[id] ?? 0),
				pauses: top3_by_key[id] ?? 0
			};
		})
		.filter((m) => m.category !== 'gc' && m.category !== 'v8' && m.category !== 'profiler')
		.sort((a, b) => b.gc_ms - a.gc_ms || b.allocated - a.allocated)
		.slice(0, 60);
	const comp = new Map<string, { allocated: number; gc_ms: number }>();
	for (const [id, allocated] of Object.entries(total_by_key)) {
		const name = dict[first_key[id]]?.component;
		if (!name) continue;
		const c = comp.get(name) ?? { allocated: 0, gc_ms: 0 };
		c.allocated += allocated;
		c.gc_ms += gc_ms_by_key[id] ?? 0;
		comp.set(name, c);
	}
	const slice_ms = slices.length ? r1(slices.reduce((a, s) => a + (s.t1 - s.t0), 0) / slices.length) : 0;
	return {
		summary: {
			count: events.length,
			total_ms: r2(measured_total - overhead_total),
			max_ms: r2(Math.max(0, ...pauses.map((p) => p.ms))),
			measured_ms: r2(measured_total),
			overhead_ms: r2(overhead_total),
			minor: events.filter((e) => e.kind === 'minor').length,
			major: events.filter((e) => e.kind === 'major').length,
			incremental: events.filter((e) => e.kind === 'incremental').length,
			weak: events.filter((e) => e.kind === 'weak').length,
			allocated_mb: mb(total_bytes),
			alloc_rate_mb_s: input.window_ms > 0 ? r1((total_bytes / 1048576) / (input.window_ms / 1000)) : 0,
			...(input.retained_mb !== undefined ? { retained_mb: input.retained_mb } : {}),
			slices: slices.length,
			slice_ms
		},
		pauses,
		makers,
		components: [...comp.entries()].map(([name, c]) => ({ name, allocated: c.allocated, gc_ms: r2(c.gc_ms) })).sort((a, b) => b.gc_ms - a.gc_ms || b.allocated - a.allocated)
	};
}
