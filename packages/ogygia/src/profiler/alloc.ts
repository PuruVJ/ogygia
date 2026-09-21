/**
 * ALLOCATION ON THE TIMELINE — the heap's size sampled finely while the recording ran, turned
 * into bursts: the stretches where the heap grew fastest, each joined to what the CPU was
 * running at that moment. The makers table (gc.ts) says WHO allocated over the whole window;
 * this says WHEN, and what ran when it happened. Pure: the host supplies the samples (on the
 * capture's clock, ms from the profiler's start), the CPU segments on the same clock, and the
 * GC pauses (a pause inside an interval shrinks the heap, so that interval's growth is a floor,
 * not the allocation).
 *
 * The samples come from a timer: a synchronous stretch cannot be sampled while it runs, so an
 * interval is at least one yield of the event loop long — "between two awaits", never inside one.
 */

export interface HeapSample {
	/** ms on the capture's clock */
	t: number;
	/** used heap, MB */
	mb: number;
}

export interface AllocBurst {
	t0: number;
	t1: number;
	/** MB the heap grew across the interval (a floor when `gc` is set) */
	mb: number;
	/** MB per second over the interval */
	rate: number;
	/** what the CPU was running across the interval, by share of its CPU time */
	running: { label: string; category: string; file?: string; share: number }[];
	/** a GC pause fell inside the interval: the growth is what survived it, the allocation was more */
	gc: boolean;
}

export interface AllocTimeline {
	/** the samples on the capture's clock (kept for the chart) */
	samples: HeapSample[];
	/** the fastest-growing intervals, rate desc */
	bursts: AllocBurst[];
	/** MB the heap grew over every interval that grew (what the render put on the heap between
	 *  collections; the GC attribution's allocated bytes are the same thing measured by sampling) */
	grown_mb: number;
	/** ms between samples as recorded (the timer's period; longer where the loop was blocked) */
	period_ms: number;
	/** the longest gap between two samples: the longest synchronous stretch the loop saw */
	longest_gap_ms: number;
	/** the one window the report explains, on the same clock */
	window?: { offset_ms: number; ms: number };
}

export interface AllocInput {
	samples: HeapSample[];
	/** CPU segments on the capture's clock */
	running?: { t0: number; t1: number; label: string; category: string; file?: string }[];
	/** GC pauses on the capture's clock */
	gc?: { t: number; ms: number }[];
	window?: { offset_ms: number; ms: number };
	limit?: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function alloc_timeline(input: AllocInput): AllocTimeline | undefined {
	const s = input.samples;
	if (s.length < 3) return undefined;
	const running = input.running ?? [];
	const gc = input.gc ?? [];
	let ri = 0;
	let gi = 0;
	let grown = 0;
	let longest = 0;
	let period_sum = 0;
	const raw: AllocBurst[] = [];
	for (let i = 1; i < s.length; i++) {
		const t0 = s[i - 1].t;
		const t1 = s[i].t;
		const len = t1 - t0;
		if (len <= 0) continue;
		period_sum += len;
		if (len > longest) longest = len;
		const mb = s[i].mb - s[i - 1].mb;
		// a pause inside the interval: the heap shrank, so a small or negative growth says nothing
		while (gi < gc.length && gc[gi].t + gc[gi].ms < t0) gi++;
		let had_gc = false;
		for (let g = gi; g < gc.length && gc[g].t <= t1; g++) had_gc = true;
		if (mb <= 0) continue;
		grown += mb;
		// what ran across it, by overlap (the segments are sorted; `ri` never moves back past t0)
		while (ri < running.length && running[ri].t1 < t0) ri++;
		const by = new Map<string, { label: string; category: string; file?: string; ms: number }>();
		let cpu = 0;
		for (let r = ri; r < running.length && running[r].t0 <= t1; r++) {
			const seg = running[r];
			const ov = Math.min(seg.t1, t1) - Math.max(seg.t0, t0);
			if (ov <= 0) continue;
			cpu += ov;
			const k = seg.label + '\0' + (seg.file ?? '');
			const hit = by.get(k);
			if (hit) hit.ms += ov;
			else by.set(k, { label: seg.label, category: seg.category, ...(seg.file ? { file: seg.file } : {}), ms: ov });
		}
		const top = [...by.values()].sort((a, b) => b.ms - a.ms).slice(0, 4);
		raw.push({
			t0: round2(t0),
			t1: round2(t1),
			mb: round1(mb),
			rate: round1((mb / len) * 1000),
			running: top.map((x) => ({ label: x.label, category: x.category, ...(x.file ? { file: x.file } : {}), share: cpu > 0 ? round2(x.ms / cpu) : 0 })),
			gc: had_gc
		});
	}
	const limit = input.limit ?? 12;
	// a burst is worth a row when it is a real share of what grew: the top by rate among those
	const floor = Math.max(0.5, grown * 0.02);
	const bursts = raw
		.filter((b) => b.mb >= floor)
		.sort((a, b) => b.rate - a.rate)
		.slice(0, limit);
	return {
		samples: s.map((x) => ({ t: round2(x.t), mb: round1(x.mb) })),
		bursts,
		grown_mb: round1(grown),
		period_ms: round1(period_sum / Math.max(1, s.length - 1)),
		longest_gap_ms: round1(longest),
		...(input.window ? { window: input.window } : {})
	};
}
