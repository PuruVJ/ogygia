/**
 * THE REQUEST TIMELINE — why ONE render took as long as it did.
 *
 * The CPU sampler says where the CPU went; the net/io recorders say what the server waited on.
 * Neither alone explains wall time. This module puts both on one clock and walks the request's
 * window from start to end: at every instant the server was either RUNNING some function (a CPU
 * segment, owned by the component or app function on the stack), WAITING on outbound calls / I/O
 * primitives (a wait segment, with the calls in flight — several at once is a parallel group), or
 * in a GAP nothing recorded (a promise chain, a driver the hooks cannot see). The ordered segments
 * ARE the critical path; the same walk yields:
 *
 *   • PHASES — each segment is classified by the Kit phase its stack sits in (hooks, load, render,
 *     ogygia's transform, Kit's own routing/serialization); a wait is charged to the phase of the
 *     code that was running just before it (the awaiting code). "load: 12 ms CPU + 210 ms waiting"
 *     is the one-glance answer to "data or rendering?".
 *   • PARALLELIZABLE CHAINS — consecutive waits on DIFFERENT calls with (almost) no CPU between
 *     them are awaits in a row. If they are independent, running them together would cost the
 *     longest instead of the sum: the saving is `sum − max`, stated as such.
 *
 * Clock: V8's sample times are µs from `profile.startTime`; net/io `start` are `performance.now()`
 * ms. The capture records `performance.now()` right after `Profiler.start` (`perf_start`), and
 * `perf_start + (t_us − startTime) / 1000` puts every sample on the net/io axis (sub-ms skew).
 *
 * Pure: no Node imports, no DOM. `analyze` calls it with the frame table it already resolved.
 */
import type { CpuProfile, FrameCategory } from './analyze.js';

export type Phase = 'hooks' | 'load' | 'remote' | 'render' | 'ogygia' | 'kit' | 'other';

export const PHASE_LABEL: Record<Phase, string> = {
	hooks: 'hooks',
	load: 'load functions',
	remote: 'remote functions',
	render: 'component render',
	ogygia: 'ogygia transform',
	kit: 'Kit routing + response',
	other: 'other'
};

/** The frame facts the timeline needs per profile node — what `analyze` resolved. */
export interface FrameInfo {
	name: string;
	url: string;
	line: number;
	category: FrameCategory;
	pkg?: string;
}

export interface TimelineCall {
	/** performance.now() ms at start */
	start: number;
	/** ms until done (headers + body for a fetch); < 0 = never finished */
	ms: number;
	/** what to call it: `GET host/path` or `timer` / `file read` */
	label: string;
	/** 'net' (fetch / http) or an I/O primitive kind */
	kind: string;
	/** the function that started it, when resolved */
	caller?: string;
	/** the phase of the code that started it (from the caller's file); else the wait takes the
	 *  phase of whatever ran just before it */
	phase?: Phase;
	/** the first-party call path above the caller, resolved (`fetchStock (…)` ← `load (…)`) */
	callers?: string[];
	/** the upstream's own Server-Timing: what their side spent the wait on */
	timings?: { name: string; ms: number; desc?: string }[];
}

export interface TimelineInput {
	/** performance.now() at `Profiler.start` */
	perf_start: number;
	/** the request's window, performance.now() ms */
	window: { start: number; end: number };
	calls: TimelineCall[];
	/** page mode: every run's window (for the per-run component split) */
	runs?: { start: number; end: number }[];
	/** every async resource the hooks saw (waits or not): a gap is named after what was pending */
	pending?: { start: number; end: number; label: string; kind: string }[];
}

/** Which call started only once another finished: the await that serialized them. */
export interface AwaitEdge {
	/** the call that had to finish first */
	from: string;
	/** the call that started right after it */
	to: string;
	/** ms between the one's end and the other's start (CPU, or nothing) */
	gap_ms: number;
	/** where `to` was started from — the await site to look at */
	at?: string;
	/** the file:line chain above it, when captured */
	callers?: string[];
}

/** One call as the causality graph draws it: a box on the render's clock, in a lane. */
export interface AwaitNode {
	label: string;
	t0: number;
	t1: number;
	lane: number;
	kind: string;
	caller?: string;
}

export interface Segment {
	/** ms from the window start */
	t0: number;
	t1: number;
	kind: 'cpu' | 'wait' | 'gap';
	/** cpu: the owning component / function; wait: the call (or "N calls in parallel") */
	label: string;
	/** cpu: the leaf-most named frame when it differs from the owner (what inside it burned) */
	detail?: string;
	/** cpu: owner's `file:line` */
	file?: string;
	category: FrameCategory;
	phase: Phase;
	/** wait: every call in flight during the segment */
	calls?: { label: string; ms: number; caller?: string; callers?: string[]; timings?: TimelineCall['timings'] }[];
	/** the innermost `span()` this segment sits inside, when any */
	within?: string;
	/** gap: the async resources that were pending across it — what the wait most likely was */
	pending?: string[];
}

export interface PhaseRow {
	phase: Phase;
	cpu_ms: number;
	wait_ms: number;
}

export interface ParallelGroup {
	/** the calls, in the order they ran */
	calls: string[];
	/** their summed wait */
	ms: number;
	/** what running them together would save (sum − longest) */
	save_ms: number;
	/** segment indices in `segments` */
	at: number[];
}

/** One Kit load function's lane: when it ran, what it cost, and whether it awaited its parent. */
export interface LoadLane {
	/** the load file, relative to src (`routes/hell/+page.server.ts`) */
	file: string;
	level: 'layout' | 'page' | 'error';
	/** `+page.server.ts` runs on the server only; a universal `+page.ts` runs in the browser too */
	kind: 'server' | 'universal';
	/** ms from the window start: first and last moment this load was on the CPU or waiting */
	t0: number;
	t1: number;
	cpu_ms: number;
	wait_ms: number;
	/** Kit's `parent()` ran under this load: it awaited the layout's data before doing its own work */
	awaited_parent: boolean;
}

/** The page load began only after the layout load finished — Kit runs them together unless the
 *  page awaits `parent()` (or the layout's data is otherwise on its path). */
export interface LoadChain {
	layout: string;
	page: string;
	/** how long the page's load sat behind the layout's: the most that running them together saves */
	serial_ms: number;
	/** a `parent()` frame was seen under the page load (else inferred from the timing alone) */
	explicit: boolean;
}

export interface Timeline {
	window_ms: number;
	/** the app's CPU inside the window (the profiler's own frames are in `overhead_ms`, not here) */
	cpu_ms: number;
	wait_ms: number;
	gap_ms: number;
	overhead_ms: number;
	segments: Segment[];
	phases: PhaseRow[];
	parallelizable: ParallelGroup[];
	/** Kit's load functions, one lane each (absent when none ran in the window) */
	lanes?: LoadLane[];
	chain?: LoadChain;
	/** THE CAUSALITY GRAPH of the waits: every call as a box in a lane, and an edge wherever a
	 *  call started only once another had finished (the await that serialized them) */
	awaits?: { nodes: AwaitNode[]; edges: AwaitEdge[] };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── phase markers ────────────────────────────────────────────────────────────────────────────
const KIT_LOAD_RE = /\/runtime\/server\/page\/load_data\.js/;
/** Kit remote functions (`query` / `command` / `form` / `prerender` from a `.remote.ts`): the app's
 *  remote file itself, or Kit's remote runtime that runs it. A remote awaited during SSR — an
 *  island's top-level `await getX()`, a `load` calling one — is on the critical path like a load. */
const KIT_REMOTE_RE = /\/runtime\/(?:app\/server\/remote|server\/remote)\//;
const APP_REMOTE_FILE_RE = /\.remote\.[jt]s(?:\.js)?$/;
const KIT_RENDER_RE = /\/runtime\/server\/page\/render\.js/;
const KIT_RUNTIME_RE = /@sveltejs\/kit\/src\/runtime\/server\//;
const APP_LOAD_FILE_RE = /(?:^|[/\\])(?:\+(?:page|layout)(?:\.server)?\.[jt]s|_(?:page|layout)(?:\.server)?\.[jt]s\.js)$/;
const APP_HOOKS_FILE_RE = /(?:^|[/\\])hooks\.server\.[jt]s(?:\.js)?$/;
/** A load file inside a resolved caller (`load (routes/x/+page.server.ts:44)`) or a frame url. */
const LOAD_FILE_IN_TEXT_RE = /((?:[^\s()]*[/\\])?[+_](page|layout|error)(\.server)?\.[jt]s(?:\.js)?)(?::\d+)?/;
const SRC_REL_RE = /[/\\]src[/\\](.*)$/;

/** The lane a load frame / caller belongs to: `{ file, level, kind }`, or null. */
export function load_lane_of(text: string): Pick<LoadLane, 'file' | 'level' | 'kind'> | null {
	const m = LOAD_FILE_IN_TEXT_RE.exec(text);
	if (!m) return null;
	let file = m[1].replace(/\\/g, '/');
	const rel = SRC_REL_RE.exec(file);
	// relative to src when the path has one; else (a built chunk, no sourcemap) the last three segments
	file = rel ? rel[1] : file.split('/').filter(Boolean).slice(-3).join('/');
	// Kit's built name (`_page.server.ts.js`) → the source spelling
	file = file.replace(/(^|\/)_(page|layout|error)((?:\.server)?\.[jt]s)\.js$/, (_, pre, l, ext) => `${pre}+${l}${ext}`);
	return { file, level: m[2] as LoadLane['level'], kind: m[3] ? 'server' : 'universal' };
}
const OGYGIA_SERVER_RE = /\/ogygia\/(?:src|dist)\/(?!profiler\/)/;

/** The Kit phase of ONE frame, or null when the frame says nothing about it. */
export function phase_of_frame(f: FrameInfo): Phase | null {
	if (f.name === 'inject_client_seeds') return 'ogygia';
	const url = f.url;
	if (!url) return null;
	if (OGYGIA_SERVER_RE.test(url)) return 'ogygia';
	// a remote function's own code is deeper than the component or load that awaited it, so it
	// wins the leaf-first walk: its CPU and its waits read as "remote functions"
	if (APP_REMOTE_FILE_RE.test(url) || KIT_REMOTE_RE.test(url)) return 'remote';
	if (f.category === 'component' || f.category === 'svelte' || KIT_RENDER_RE.test(url))
		return 'render';
	if (KIT_LOAD_RE.test(url) || APP_LOAD_FILE_RE.test(url)) return 'load';
	if (APP_HOOKS_FILE_RE.test(url)) return 'hooks';
	if (KIT_RUNTIME_RE.test(url)) return 'kit';
	return null;
}

/** Walk a stack leaf → root; the first frame that names a phase wins (the deepest decision). */
export function phase_of_stack(frames: FrameInfo[]): Phase {
	for (const f of frames) {
		const p = phase_of_frame(f);
		if (p) return p;
	}
	return 'other';
}

/** The frame a CPU segment is charged to: the deepest component, else the deepest named app
 *  function, else the deepest dependency, else the runtime bucket the leaf is in. */
export function owner_of_stack(frames: FrameInfo[]): {
	label: string;
	file: string;
	category: FrameCategory;
	detail?: string;
} {
	const named = (f: FrameInfo) => f.name && f.name !== '(anonymous)' && !f.name.startsWith('(');
	const file_of = (f: FrameInfo) => (f.url ? `${short(f.url)}:${f.line}` : '');
	const leaf = frames.find((f) => named(f) && f.category !== 'v8' && f.category !== 'gc');
	const pick = (f: FrameInfo, label: string) => ({
		label,
		file: file_of(f),
		category: f.category,
		detail: leaf && leaf !== f ? leaf.name + (leaf.pkg ? ` (${leaf.pkg})` : '') : undefined
	});
	let comp: FrameInfo | undefined;
	let app: FrameInfo | undefined;
	let dep: FrameInfo | undefined;
	for (const f of frames) {
		if (!comp && f.category === 'component') comp = f;
		if (!app && f.category === 'app' && named(f)) app = f;
		if (!dep && f.category === 'dependency' && named(f)) dep = f;
	}
	if (comp) return pick(comp, comp.name);
	if (app) return pick(app, app.name);
	if (dep) return pick(dep, dep.pkg ? `${dep.name} (${dep.pkg})` : dep.name);
	const top = frames[0];
	if (!top) return { label: 'unknown', file: '', category: 'unknown' };
	if (top.category === 'gc') return { label: 'garbage collection', file: '', category: 'gc' };
	if (top.category === 'svelte') return pick(top, 'svelte internals');
	if (top.category === 'node') return pick(top, `node core: ${top.name || '(native)'}`);
	if (top.category === 'profiler') return pick(top, 'profiler overhead');
	return pick(top, top.name || 'v8');
}

function short(url: string): string {
	const nm = url.lastIndexOf('node_modules/');
	if (nm !== -1) return url.slice(nm + 'node_modules/'.length);
	const parts = url.split('/');
	return parts.length > 4 ? parts.slice(-4).join('/') : url;
}

/**
 * Build the timeline. `frame_of` resolves a profile node to its frame facts, `parent_of` the
 * tree; both come from `analyze`'s own tables so the timeline agrees with every other view.
 */
export function build_timeline(
	profile: CpuProfile,
	frame_of: (id: number) => FrameInfo,
	parent_of: (id: number) => number | undefined,
	input: TimelineInput
): Timeline {
	const { start: w0, end: w1 } = input.window;
	const window_ms = Math.max(w1 - w0, 0.01);

	// ── CPU segments from the samples inside the window ──
	interface Described {
		owner: ReturnType<typeof owner_of_stack>;
		phase: Phase;
		idle: boolean;
		/** the nearest Kit load file on the stack, and whether Kit's `parent()` is above the sample */
		lane: ReturnType<typeof load_lane_of>;
		in_parent: boolean;
	}
	const stack_memo = new Map<number, Described>();
	const describe = (id: number): Described => {
		const hit = stack_memo.get(id);
		if (hit) return hit;
		const frames: FrameInfo[] = [];
		let cur: number | undefined = id;
		while (cur !== undefined && frames.length < 64) {
			frames.push(frame_of(cur));
			cur = parent_of(cur);
		}
		const leaf = frames[0];
		const idle = !!leaf && (leaf.category === 'idle' || leaf.name === '(root)' || leaf.name === '(program)');
		let lane: Described['lane'] = null;
		let in_parent = false;
		for (const f of frames) {
			if (!lane && f.url && APP_LOAD_FILE_RE.test(f.url)) lane = load_lane_of(f.url);
			if (f.name === 'parent' && KIT_LOAD_RE.test(f.url)) in_parent = true;
		}
		const d = { owner: owner_of_stack(frames), phase: phase_of_stack(frames), idle, lane, in_parent };
		stack_memo.set(id, d);
		return d;
	};
	interface Cpu {
		t0: number;
		t1: number;
		owner: ReturnType<typeof owner_of_stack>;
		phase: Phase;
	}
	const cpu: Cpu[] = [];
	const lanes = new Map<string, LoadLane>();
	/** a lane's wait intervals, unioned at the end (parallel calls overlap) */
	const lane_waits = new Map<string, [number, number][]>();
	const lane_row = (l: NonNullable<Described['lane']>) => {
		let r = lanes.get(l.file);
		if (!r) lanes.set(l.file, (r = { ...l, t0: Infinity, t1: -Infinity, cpu_ms: 0, wait_ms: 0, awaited_parent: false }));
		return r;
	};
	const samples = profile.samples ?? [];
	const deltas = profile.timeDeltas ?? [];
	let t_us = profile.startTime;
	for (let i = 0; i < samples.length; i++) {
		const d = deltas[i] ?? 0;
		t_us += d;
		const t = input.perf_start + (t_us - profile.startTime) / 1000;
		if (t < w0 || t > w1 || d <= 0) continue;
		const info = describe(samples[i]);
		if (info.idle) continue;
		const s0 = Math.max(t - d / 1000, w0) - w0;
		const s1 = t - w0;
		if (info.lane) {
			const row = lane_row(info.lane);
			row.t0 = Math.min(row.t0, s0);
			row.t1 = Math.max(row.t1, s1);
			if (info.owner.category !== 'profiler') row.cpu_ms += s1 - s0;
			if (info.in_parent) row.awaited_parent = true;
		}
		const last = cpu[cpu.length - 1];
		// merge into the previous segment when it is the same owner and the gap is tiny
		if (
			last &&
			last.owner.label === info.owner.label &&
			last.phase === info.phase &&
			s0 - last.t1 <= (d / 1000) * 2
		) {
			last.t1 = s1;
		} else cpu.push({ t0: s0, t1: s1, owner: info.owner, phase: info.phase });
	}

	// ── wait intervals from the calls inside the window ──
	interface Wait {
		t0: number;
		t1: number;
		call: TimelineCall;
	}
	const waits: Wait[] = [];
	for (const c of input.calls) {
		if (c.ms < 0) continue;
		const a = Math.max(c.start, w0) - w0;
		const b = Math.min(c.start + c.ms, w1) - w0;
		if (b - a < 0.05) continue;
		waits.push({ t0: a, t1: b, call: c });
		// a call started from a load file extends that load's lane — a span too: a load that waits
		// inside `span('db.x', …)` on a driver the hooks cannot see is still waiting
		if (c.caller) {
			const l = load_lane_of(c.caller);
			if (l) {
				const row = lane_row(l);
				row.t0 = Math.min(row.t0, a);
				row.t1 = Math.max(row.t1, b);
				(lane_waits.get(l.file) ?? lane_waits.set(l.file, []).get(l.file)!).push([a, b]);
			}
		}
	}

	// ── sweep: at every boundary decide cpu / wait / gap ──
	const bounds = new Set<number>([0, window_ms]);
	for (const c of cpu) {
		bounds.add(c.t0);
		bounds.add(c.t1);
	}
	for (const w of waits) {
		bounds.add(w.t0);
		bounds.add(w.t1);
	}
	// a pending resource's edges split a gap too, so "pending: X" names exactly the stretch X covered
	for (const p of input.pending ?? []) {
		const a = p.start - w0;
		const b = p.end - w0;
		if (a > 0 && a < window_ms) bounds.add(a);
		if (b > 0 && b < window_ms) bounds.add(b);
	}
	const ticks = [...bounds].sort((a, b) => a - b);
	const segments: Segment[] = [];
	let last_phase: Phase = 'other';
	let ci = 0; // cpu cursor (cpu segments are time-ordered and non-overlapping)
	for (let i = 0; i + 1 < ticks.length; i++) {
		const a = ticks[i];
		const b = ticks[i + 1];
		if (b - a <= 0) continue;
		const mid = (a + b) / 2;
		while (ci < cpu.length && cpu[ci].t1 <= a) ci++;
		const on_cpu = ci < cpu.length && cpu[ci].t0 <= mid && mid < cpu[ci].t1 ? cpu[ci] : null;
		// SPANS are the overlay: the innermost one open at this instant names what a call or a gap
		// sits inside — "GET api/x, in db.user"; a gap with no call becomes "waiting in db.user"
		const all_active = waits.filter((w) => w.t0 <= mid && mid < w.t1);
		const open_spans = all_active.filter((w) => w.call.kind === 'span');
		const inner = open_spans.length
			? open_spans.reduce((m, w) => (w.call.ms < m.call.ms ? w : m), open_spans[0])
			: null;
		let seg: Segment;
		if (on_cpu) {
			last_phase = on_cpu.phase;
			seg = {
				t0: a,
				t1: b,
				kind: 'cpu',
				label: on_cpu.owner.label,
				detail: on_cpu.owner.detail,
				file: on_cpu.owner.file,
				category: on_cpu.owner.category,
				phase: on_cpu.phase,
				...(inner ? { within: inner.call.label } : {})
			};
		} else {
			const active = all_active.filter((w) => w.call.kind !== 'span');
			if (active.length) {
				const calls = active.map((w) => ({
					label: w.call.label,
					ms: round2(w.call.ms),
					caller: w.call.caller,
					...(w.call.callers && w.call.callers.length > 1 ? { callers: w.call.callers } : {}),
					...(w.call.timings ? { timings: w.call.timings } : {})
				}));
				// the phase of the code that started the (longest) call wins over "what ran before"
				const owner = active.reduce((m, w) => (w.call.ms > m.call.ms ? w : m), active[0]);
				seg = {
					t0: a,
					t1: b,
					kind: 'wait',
					label: calls.length === 1 ? calls[0].label : `${calls.length} calls in parallel`,
					category: 'idle',
					phase: owner.call.phase ?? inner?.call.phase ?? last_phase,
					calls,
					...(inner ? { within: inner.call.label } : {})
				};
			} else if (inner) {
				// nothing the hooks can see, but the app named it: the span IS the wait
				seg = {
					t0: a,
					t1: b,
					kind: 'wait',
					label: `in ${inner.call.label}`,
					category: 'idle',
					phase: inner.call.phase ?? last_phase,
					calls: [{ label: inner.call.label, ms: round2(inner.call.ms), caller: inner.call.caller }],
					within: inner.call.label
				};
			} else {
				// name the gap after what was pending across it (the resources the hooks saw but
				// the sweep does not count as waits: a tick, an immediate, an open socket)
				const pend = (input.pending ?? [])
					.filter((p) => p.start - w0 <= mid && p.end - w0 >= mid)
					.map((p) => p.label);
				const uniq = [...new Set(pend)];
				seg = {
					t0: a,
					t1: b,
					kind: 'gap',
					label: uniq.length ? `nothing recorded — pending: ${uniq[0]}${uniq.length > 1 ? ` (+${uniq.length - 1})` : ''}` : 'nothing recorded',
					category: 'unknown',
					phase: last_phase,
					...(uniq.length ? { pending: uniq.slice(0, 6) } : {})
				};
			}
		}
		const prev = segments[segments.length - 1];
		if (
			prev &&
			prev.kind === seg.kind &&
			prev.label === seg.label &&
			prev.phase === seg.phase &&
			prev.detail === seg.detail &&
			prev.within === seg.within &&
			(prev.pending?.join() ?? '') === (seg.pending?.join() ?? '')
		) {
			prev.t1 = b;
		} else segments.push(seg);
	}
	for (const s of segments) {
		s.t0 = round2(s.t0);
		s.t1 = round2(s.t1);
	}

	// ── totals + phases ──
	let cpu_ms = 0,
		wait_ms = 0,
		gap_ms = 0;
	const phase_map = new Map<Phase, PhaseRow>();
	const phase_row = (p: Phase) => {
		let r = phase_map.get(p);
		if (!r) phase_map.set(p, (r = { phase: p, cpu_ms: 0, wait_ms: 0 }));
		return r;
	};
	let overhead_ms = 0;
	for (const s of segments) {
		const len = s.t1 - s.t0;
		if (s.kind === 'cpu' && s.category === 'profiler') {
			// the profiler's own CPU: drawn (so the bar is honest) but not the app's time
			overhead_ms += len;
		} else if (s.kind === 'cpu') {
			cpu_ms += len;
			phase_row(s.phase).cpu_ms += len;
		} else if (s.kind === 'wait') {
			wait_ms += len;
			phase_row(s.phase).wait_ms += len;
		} else gap_ms += len;
	}
	const phases = [...phase_map.values()]
		.map((r) => ({ phase: r.phase, cpu_ms: round2(r.cpu_ms), wait_ms: round2(r.wait_ms) }))
		.sort((x, y) => y.cpu_ms + y.wait_ms - (x.cpu_ms + x.wait_ms));

	const timeline: Timeline = {
		window_ms: round2(window_ms),
		cpu_ms: round2(cpu_ms),
		wait_ms: round2(wait_ms),
		gap_ms: round2(gap_ms),
		overhead_ms: round2(overhead_ms),
		segments,
		phases,
		parallelizable: []
	};
	timeline.parallelizable = find_parallelizable(timeline);
	timeline.awaits = await_graph(input, w0, w1);

	// ── Kit's load lanes + the parent() chain ──
	for (const [file, list] of lane_waits) {
		// the union of the wait intervals: three calls in a Promise.all are one stretch of waiting
		list.sort((x, y) => x[0] - y[0]);
		let total = 0;
		let cur: [number, number] | null = null;
		for (const [a, b] of list) {
			if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
			else {
				if (cur) total += cur[1] - cur[0];
				cur = [a, b];
			}
		}
		if (cur) total += cur[1] - cur[0];
		lanes.get(file)!.wait_ms = total;
	}
	const lane_list = [...lanes.values()]
		.filter((l) => Number.isFinite(l.t0))
		.map((l) => ({ ...l, t0: round2(l.t0), t1: round2(l.t1), cpu_ms: round2(l.cpu_ms), wait_ms: round2(l.wait_ms) }))
		.sort((x, y) => x.t0 - y.t0);
	if (lane_list.length) {
		timeline.lanes = lane_list;
		// the LAST layout lane to finish against the page lane: the page's load started only once
		// the layout's was done, while the layout's was real time (a wait, or ≥ 2 ms of work)
		// a server page load's `parent()` waits for the server layout loads; a universal one for the
		// universal ones — so only lanes of the page's own kind can be the chain's other end
		const page = lane_list.find((l) => l.level === 'page');
		const layout = lane_list
			.filter((l) => l.level === 'layout' && l.kind === page?.kind && l.t1 - l.t0 >= 2 && (l.wait_ms > 0 || l.cpu_ms >= 2))
			.sort((x, y) => y.t1 - x.t1)[0];
		if (page && layout && (page.awaited_parent || page.t0 >= layout.t1 - 0.25)) {
			timeline.chain = {
				layout: layout.file,
				page: page.file,
				serial_ms: round2(Math.max(0, Math.min(layout.t1, page.t0) - layout.t0)),
				explicit: page.awaited_parent
			};
		}
	}
	return timeline;
}

/**
 * THE CAUSALITY GRAPH: every call (net + I/O primitives, not spans) as a box on the render's
 * clock, laid into lanes so overlapping calls sit on different rows, and an edge from a call to
 * the one that started right after it finished while nothing else was in flight — that start
 * waited for that end, and `at` is the line that did the waiting. Edges are what the
 * "awaits in a row" callouts are made of; the graph shows them with the exact await site.
 */
export function await_graph(input: TimelineInput, w0: number, w1: number): { nodes: AwaitNode[]; edges: AwaitEdge[] } {
	const calls = input.calls
		.filter((c) => c.kind !== 'span' && c.ms >= 0 && c.start <= w1 && c.start + c.ms >= w0)
		.map((c) => ({ c, t0: round2(Math.max(c.start, w0) - w0), t1: round2(Math.min(c.start + c.ms, w1) - w0) }))
		.sort((x, y) => x.t0 - y.t0 || x.t1 - y.t1)
		.slice(0, 200);
	// lanes: first free row whose last call ended before this one starts
	const lane_end: number[] = [];
	const nodes: AwaitNode[] = calls.map(({ c, t0, t1 }) => {
		let lane = lane_end.findIndex((e) => e <= t0);
		if (lane === -1) lane = lane_end.push(0) - 1;
		lane_end[lane] = t1;
		return { label: c.label, t0, t1, lane, kind: c.kind, ...(c.caller ? { caller: c.caller } : {}) };
	});
	const edges: AwaitEdge[] = [];
	for (let i = 0; i < calls.length; i++) {
		const cur = calls[i];
		// the latest call that ended before this one started, within 5 ms
		let prev: (typeof calls)[number] | null = null;
		for (let j = 0; j < i; j++) {
			const p = calls[j];
			if (p.t1 <= cur.t0 + 0.05 && cur.t0 - p.t1 <= 5 && (!prev || p.t1 > prev.t1)) prev = p;
		}
		if (!prev) continue;
		// serialized only if nothing else was still in flight when this one started
		const in_flight = calls.some((o, j) => j !== i && o !== prev && o.t0 < cur.t0 - 0.05 && o.t1 > cur.t0 + 0.05);
		if (in_flight) continue;
		edges.push({
			from: prev.c.label,
			to: cur.c.label,
			gap_ms: round2(Math.max(0, cur.t0 - prev.t1)),
			...(cur.c.caller ? { at: cur.c.caller } : {}),
			...(cur.c.callers && cur.c.callers.length > 1 ? { callers: cur.c.callers } : {})
		});
	}
	return { nodes, edges };
}

/**
 * Awaits in a row: consecutive single-call waits on DIFFERENT calls with ≤ 5 ms of CPU between
 * them. Read off the COALESCED view (`coalesce`), where a wait chopped by microtask slivers is one
 * block again — on the raw segments the same call reappearing after a sliver broke every chain.
 * `at` indexes that view (the same one the UI draws).
 */
export function find_parallelizable(t: Timeline): ParallelGroup[] {
	const view = coalesce(t);
	const parallelizable: ParallelGroup[] = [];
	let group: { at: number[]; labels: string[]; lens: number[] } | null = null;
	const flush = () => {
		if (group && group.at.length >= 2) {
			const sum = group.lens.reduce((a, c) => a + c, 0);
			const max = Math.max(...group.lens);
			if (sum - max >= 1) {
				parallelizable.push({ calls: group.labels, ms: round2(sum), save_ms: round2(sum - max), at: group.at });
			}
		}
		group = null;
	};
	let cpu_between = 0;
	for (let i = 0; i < view.length; i++) {
		const s = view[i];
		if (s.kind === 'wait' && s.calls && s.calls.length === 1) {
			const label = s.calls[0].label;
			// the same call continuing after a hair of nothing: the chain's last link grows
			if (group && group.labels[group.labels.length - 1] === label && cpu_between <= 5) {
				group.lens[group.lens.length - 1] += s.t1 - s.t0;
				cpu_between = 0;
				continue;
			}
			if (group && (cpu_between > 5 || group.labels.includes(label))) flush();
			if (!group) group = { at: [], labels: [], lens: [] };
			group.at.push(i);
			group.labels.push(label);
			group.lens.push(s.t1 - s.t0);
			cpu_between = 0;
		} else if (s.kind === 'cpu') {
			cpu_between += s.t1 - s.t0;
			if (cpu_between > 5) flush();
		} else if (s.kind === 'wait') flush(); // a parallel group already
	}
	flush();
	return parallelizable;
}

/**
 * READABLE SEGMENTS: the sweep is exact but a render is hundreds of slivers — every card's CPU
 * is its own owner, and a wait is chopped by every microtask that runs inside it. For the bar and
 * the steps, fold anything below `min_ms` into its neighbours: a run of small pieces becomes ONE
 * segment named after what dominated it (`mostly ProductCard (+11 more)`), and a wait interrupted
 * by small CPU slices reads as one wait again. `parts` says how many raw segments a merged one
 * holds; the raw list stays in `segments` for the tooltip's exact numbers.
 */
export interface ViewSegment extends Segment {
	parts: number;
	/** the raw pieces that were folded in, by label, largest first (for the tooltip) */
	inside?: { label: string; kind: Segment['kind']; ms: number }[];
}

export function coalesce(t: Timeline, min_ms = Math.max(t.window_ms * 0.012, 1)): ViewSegment[] {
	const out: ViewSegment[] = [];
	let small: Segment[] = [];
	const len = (s: Segment) => s.t1 - s.t0;
	const same = (a: Segment, b: Segment) => a.kind === b.kind && a.label === b.label && a.within === b.within;
	const fold = (list: Segment[]): ViewSegment => {
		const by = new Map<string, { label: string; kind: Segment['kind']; ms: number; seg: Segment }>();
		const kind_ms = { cpu: 0, wait: 0, gap: 0 };
		for (const s of list) {
			const k = s.kind + '\0' + s.label;
			const e = by.get(k) ?? { label: s.label, kind: s.kind, ms: 0, seg: s };
			e.ms += len(s);
			by.set(k, e);
			kind_ms[s.kind] += len(s);
		}
		const inside = [...by.values()].sort((a, b) => b.ms - a.ms);
		const kind = (Object.entries(kind_ms) as [Segment['kind'], number][]).sort((a, b) => b[1] - a[1])[0][0];
		const top = inside.find((i) => i.kind === kind) ?? inside[0];
		const phases = new Map<Phase, number>();
		for (const s of list) phases.set(s.phase, (phases.get(s.phase) ?? 0) + len(s));
		const phase = [...phases.entries()].sort((a, b) => b[1] - a[1])[0][0];
		// the span most of the block sat inside (time-weighted, like the phase)
		const withins = new Map<string | undefined, number>();
		for (const s of list) withins.set(s.within, (withins.get(s.within) ?? 0) + len(s));
		const within = [...withins.entries()].sort((a, b) => b[1] - a[1])[0][0];
		const others = inside.filter((i) => i.kind === kind).length - 1;
		return {
			t0: list[0].t0,
			t1: list[list.length - 1].t1,
			kind,
			label: list.length === 1 ? top.label : `mostly ${top.label}${others > 0 ? ` (+${others} more)` : ''}`,
			detail: list.length === 1 ? top.seg.detail : undefined,
			file: top.seg.file,
			category: top.seg.category,
			phase,
			calls: kind === 'wait' ? top.seg.calls : undefined,
			within,
			parts: list.length,
			inside: list.length === 1 ? undefined : inside.map(({ label, kind, ms }) => ({ label, kind, ms: Math.round(ms * 100) / 100 }))
		};
	};
	const flush_small = () => {
		if (!small.length) return;
		const total = small.reduce((s, x) => s + len(x), 0);
		const last = out[out.length - 1];
		// a small run (slivers of CPU, a hair of nothing-recorded) after a big block: give it to
		// that block rather than draw it as its own thread
		if (last && total < min_ms && small.every((s) => s.kind !== 'wait' || same(s, last))) {
			last.t1 = small[small.length - 1].t1;
			last.parts += small.length;
		} else out.push(fold(small));
		small = [];
	};
	for (const s of t.segments) {
		if (len(s) >= min_ms) {
			const last = out[out.length - 1];
			// the same wait continuing after a small interruption → one wait
			if (last && same(s, last) && small.every((x) => len(x) < min_ms)) {
				last.t1 = s.t1;
				last.parts += small.length + 1;
				small = [];
				continue;
			}
			// a small run right before a big block, with nothing before it to join: it opens this
			// block (the first slivers of a wait, a hair of CPU at the window's start)
			const total = small.reduce((a, x) => a + len(x), 0);
			if (small.length && !last && total < min_ms) {
				out.push({ ...s, t0: small[0].t0, parts: small.length + 1 });
				small = [];
				continue;
			}
			flush_small();
			out.push({ ...s, parts: 1 });
		} else small.push(s);
	}
	flush_small();
	return out;
}

/** A net call's timeline label: `GET host/path` (query dropped, long paths cut). */
export function label_call(method: string, url: string): string {
	try {
		const u = new URL(url);
		const p = u.pathname.length > 40 ? u.pathname.slice(0, 37) + '…' : u.pathname;
		return `${method} ${u.host}${p}`;
	} catch {
		return `${method} ${url.length > 48 ? url.slice(0, 45) + '…' : url}`;
	}
}

/** The steps worth listing: every coalesced segment at or above `min_pct` of the window, in time
 *  order (`i` indexes the coalesced list). */
export function chain_steps(t: Timeline, min_pct = 2, max = 14): { i: number; seg: ViewSegment; ms: number; pct: number }[] {
	const rows = coalesce(t)
		.map((seg, i) => ({ i, seg, ms: round2(seg.t1 - seg.t0), pct: ((seg.t1 - seg.t0) / t.window_ms) * 100 }))
		.filter((r) => r.pct >= min_pct);
	if (rows.length <= max) return rows;
	// too many: keep the biggest `max`, back in time order
	return rows
		.sort((a, b) => b.ms - a.ms)
		.slice(0, max)
		.sort((a, b) => a.i - b.i);
}
