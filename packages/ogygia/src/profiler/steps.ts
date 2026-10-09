/**
 * THE RENDER, STEP BY STEP — the one window's timeline read as a sequence: this component
 * rendered for this long, then the server waited for that call, then the next component… Each
 * step carries the running totals (how far into the render, how much CPU so far) and, from the
 * stack index, the stack at its middle, so the report can be stepped through like a debugger
 * instead of read as a chart. Pure over the timeline (timeline.ts) and the index (analyze.ts).
 */
import type { Segment, Timeline } from './timeline.js';
import type { StackIndex } from './analyze.js';
import { stack_at } from './stacks.js';

export interface RenderStep {
	i: number;
	t0: number;
	t1: number;
	ms: number;
	kind: 'cpu' | 'wait';
	/** cpu: the component / function that ran; wait: what the server waited for */
	label: string;
	category: string;
	file?: string;
	/** cpu: the leaf that burned inside it, when it differs */
	detail?: string;
	/** wait: every call in flight, with its own length */
	calls?: { label: string; ms: number }[];
	/** wait: the innermost span the wait sat inside */
	within?: string;
	/** the render so far, at the step's end */
	at_ms: number;
	cpu_so_far_ms: number;
	/** the stack at the step's middle, outermost first (from the index; absent when it has none) */
	stack?: string[];
	/** small consecutive steps folded into this one: how many */
	folded?: number;
}

export interface RenderSteps {
	steps: RenderStep[];
	window_ms: number;
	cpu_ms: number;
	wait_ms: number;
	/** the step the render spent the longest in */
	longest: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** `max` steps at most: the smallest consecutive steps fold into their neighbour, counted. */
export function render_steps(t: Timeline, stacks?: StackIndex, max = 80): RenderSteps | undefined {
	const segs = t.segments.filter((s) => s.kind === 'cpu' || s.kind === 'wait' || s.kind === 'gap');
	if (!segs.length) return undefined;
	// merge consecutive cpu segments of one owner; a gap is a wait for what was pending
	const merged: (Segment & { folded: number })[] = [];
	for (const s of segs) {
		const kind = s.kind === 'gap' ? 'wait' : s.kind;
		const label = s.kind === 'gap' ? (s.pending?.length ? s.pending.slice(0, 3).join(', ') : 'nothing on the CPU, nothing named in flight') : s.label;
		const last = merged[merged.length - 1];
		if (last && last.kind === kind && last.label === label && kind === 'cpu' && Math.abs(last.t1 - s.t0) < 0.05) {
			last.t1 = s.t1;
			if (!last.detail && s.detail) last.detail = s.detail;
			continue;
		}
		merged.push({ ...s, kind, label, folded: 0 });
	}
	// fold the smallest into a neighbour until under `max`
	while (merged.length > max) {
		let min_i = 0;
		for (let i = 1; i < merged.length; i++) if (merged[i].t1 - merged[i].t0 < merged[min_i].t1 - merged[min_i].t0) min_i = i;
		const victim = merged[min_i];
		const into = min_i > 0 ? merged[min_i - 1] : merged[min_i + 1];
		if (!into) break;
		if (min_i > 0) into.t1 = victim.t1;
		else into.t0 = victim.t0;
		into.folded += 1 + victim.folded;
		merged.splice(min_i, 1);
	}
	let cpu = 0;
	let wait = 0;
	let longest = 0;
	const steps: RenderStep[] = merged.map((s, i) => {
		const ms = s.t1 - s.t0;
		if (s.kind === 'cpu') cpu += ms;
		else wait += ms;
		if (ms > merged[longest].t1 - merged[longest].t0) longest = i;
		const mid = (s.t0 + s.t1) / 2;
		const at = s.kind === 'cpu' && stacks ? stack_at(stacks, mid) : null;
		return {
			i,
			t0: round2(s.t0),
			t1: round2(s.t1),
			ms: round2(ms),
			kind: s.kind as 'cpu' | 'wait',
			label: s.label,
			category: s.category,
			...(s.file ? { file: s.file } : {}),
			...(s.detail ? { detail: s.detail } : {}),
			...(s.calls?.length ? { calls: s.calls.map((c) => ({ label: c.label, ms: round2(c.ms) })) } : {}),
			...(s.within ? { within: s.within } : {}),
			at_ms: round2(s.t1),
			cpu_so_far_ms: round2(cpu),
			...(at && at.frames.length ? { stack: at.frames.map((f) => f.name) } : {}),
			...(s.folded ? { folded: s.folded } : {})
		};
	});
	return { steps, window_ms: t.window_ms, cpu_ms: round2(cpu), wait_ms: round2(wait), longest };
}
