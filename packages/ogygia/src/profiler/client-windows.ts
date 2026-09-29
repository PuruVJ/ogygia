/**
 * THE BROWSER'S CPU, CUT BY ISLAND — the trace the beacon sent, sliced to each island's hydrate
 * window (its turn → `data-hydrated`, from the visit) and to the long tasks outside every island,
 * each slice read by the same analysis as the whole (so a frame gets its source-mapped name and
 * its category). The report's browser findings then name what ran: "Heavy (120 ms; mostly
 * `render_rows` (Heavy.svelte:11))", like the devtools Page tab does from the page's own trace.
 *
 * Both clocks are the page's `performance.now()`: the trace's sample times and the visit's island
 * times line up without conversion.
 */
import type { Analysis, CpuProfile, FrameCategory } from './analyze.js';
import type { Visit } from './visit.js';

export interface WindowFn {
	name: string;
	file: string;
	line: number | null;
	category: FrameCategory;
	self_ms: number;
	total_ms: number;
}

export interface ClientWindows {
	/** per island fingerprint: CPU inside its hydrate window, and the functions that took it */
	islands: Record<string, { ms: number; top: WindowFn[] }>;
	/** the long tasks that overlapped no island's hydrate window */
	outside: { ms: number; top: WindowFn[] };
}

/** a slice this short says nothing a sampler (~10 ms) can back up */
const MIN_WINDOW_MS = 20;
const MAX_WINDOWS = 16;
const NOT_CODE = new Set<FrameCategory>(['idle', 'gc', 'v8', 'profiler']);

/** The profile with every sample outside `spans` (ms, the page clock) turned idle. */
export function window_profile(p: CpuProfile, spans: readonly (readonly [number, number])[]): CpuProfile {
	const samples = p.samples ?? [];
	const deltas = p.timeDeltas ?? [];
	const out: number[] = new Array(samples.length);
	let t_us = p.startTime;
	for (let i = 0; i < samples.length; i++) {
		t_us += deltas[i] ?? 0;
		const t = t_us / 1000;
		let inside = false;
		for (const [a, b] of spans)
			if (t >= a && t <= b) {
				inside = true;
				break;
			}
		out[i] = inside ? samples[i] : 2; // (node 2 is (idle) in a converted browser trace)
	}
	return { ...p, samples: out };
}

function top_of(a: Analysis): WindowFn[] {
	return a.functions
		.filter((f) => !NOT_CODE.has(f.category) && f.self_ms >= 1)
		.sort((x, y) => y.self_ms - x.self_ms)
		.slice(0, 3)
		.map((f) => ({ name: f.label && f.name.startsWith('(anonymous') ? f.label : f.name, file: f.url, line: f.line || null, category: f.category, self_ms: f.self_ms, total_ms: f.total_ms }));
}

/** THE SLOWEST INTERACTION'S TWO SPANS, analyzed: what ran while its input waited, and what its
 *  handlers ran (the island's own code, by its source-mapped name — the long frames only name the
 *  event dispatcher it came through). A span too short for the sampler says nothing. */
export interface InteractionCpu {
	/** the interaction's start (the page clock): which interaction of the visit this is */
	t: number;
	/** the frames went through a source map (their lines are the source's) */
	mapped: boolean;
	wait: { ms: number; top: WindowFn[] } | null;
	handler: { ms: number; top: WindowFn[] } | null;
}
export function interaction_windows(
	profile: CpuProfile,
	spans: { t: number; wait: readonly [number, number]; handler: readonly [number, number] },
	run: (p: CpuProfile) => Analysis
): InteractionCpu {
	let mapped = false;
	const one = (s: readonly [number, number]) => {
		if (s[1] - s[0] < MIN_WINDOW_MS) return null;
		const a = run(window_profile(profile, [s]));
		mapped ||= a.sourcemapped;
		return { ms: Math.round(a.busy_ms * 10) / 10, top: top_of(a) };
	};
	const wait = one(spans.wait);
	const handler = one(spans.handler);
	return { t: spans.t, mapped, wait, handler };
}

/** Each island's hydrate window and the long tasks outside them, analyzed. `run` is the report's
 *  own analysis (its resolver, renamer and chunk categories). */
export function client_windows(profile: CpuProfile, visit: Visit, run: (p: CpuProfile) => Analysis): ClientWindows {
	const windows = visit.islands
		.map((i) => ({ fp: i.fp, from: i.turn ?? i.loaded, to: i.done }))
		.filter((w) => w.to - w.from >= MIN_WINDOW_MS)
		.sort((x, y) => y.to - y.from - (x.to - x.from))
		.slice(0, MAX_WINDOWS);
	const islands: ClientWindows['islands'] = {};
	for (const w of windows) {
		const a = run(window_profile(profile, [[w.from, w.to]]));
		islands[w.fp] = { ms: Math.round(a.busy_ms * 10) / 10, top: top_of(a) };
	}
	// the long tasks that touched no island's hydration: page scripts
	const outside = visit.longtasks
		.filter((t) => !visit.islands.some((i) => t.t < i.done && t.t + t.ms > (i.turn ?? i.loaded)))
		.map((t) => [t.t, t.t + t.ms] as const);
	let out: ClientWindows['outside'] = { ms: 0, top: [] };
	if (outside.length) {
		const a = run(window_profile(profile, outside));
		out = { ms: Math.round(a.busy_ms * 10) / 10, top: top_of(a) };
	}
	return { islands, outside: out };
}
