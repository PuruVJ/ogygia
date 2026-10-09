// Awaits in a row (profiler/timeline.ts `find_parallelizable`): the CPU allowed between two waits of
// a chain scales with the waits — 5 ms, or 5% of the chain's longest wait. A fixed 5 ms broke a chain
// of 1 s waits in some runs and not others (the server answering the page's own call ran 3–9 ms in
// between), so a 2.2 s finding came and went between two profiles of the same code.
import { expect, test } from 'vitest';
import { find_parallelizable, type Segment, type Timeline } from '../src/profiler/timeline.js';

const wait = (t0: number, t1: number, label: string): Segment => ({ t0, t1, kind: 'wait', label, category: 'idle' as Segment['category'], phase: 'load' as Segment['phase'], calls: [{ label, ms: t1 - t0 }] });
const cpu = (t0: number, t1: number): Segment => ({ t0, t1, kind: 'cpu', label: 'handle', category: 'app' as Segment['category'], phase: 'load' as Segment['phase'] });
const timeline = (segments: Segment[]): Timeline => ({ window_ms: segments.at(-1)!.t1, cpu_ms: 0, wait_ms: 0, gap_ms: 0, overhead_ms: 0, segments, phases: [], parallelizable: [] }) as unknown as Timeline;

test('long waits with a few ms of CPU between: one chain, every run', () => {
	const groups = find_parallelizable(timeline([wait(0, 1000, 'timer'), cpu(1000, 1009), wait(1009, 1709, 'GET /inventory'), cpu(1709, 1717), wait(1717, 2217, 'GET /reviews')]));
	expect(groups).toHaveLength(1);
	expect(groups[0].calls).toEqual(['timer', 'GET /inventory', 'GET /reviews']);
	// (the view folds a small CPU sliver into the wait beside it: within a few ms of 1 200)
	expect(Math.abs(groups[0].save_ms - 1200)).toBeLessThan(20);
});

test('two calls of the same label (one route, two queries) are two links, not one call continuing', () => {
	const call = (t0: number, t1: number, ms: number): Segment => ({ ...wait(t0, t1, 'GET /slow-io/api'), calls: [{ label: 'GET /slow-io/api', ms }] });
	const groups = find_parallelizable(timeline([wait(0, 1000, 'timer'), cpu(1000, 1006), call(1006, 1706, 700), cpu(1706, 1712), call(1712, 2212, 500)]));
	expect(groups).toHaveLength(1);
	expect(groups[0].calls).toEqual(['timer', 'GET /slow-io/api', 'GET /slow-io/api']);
	expect(Math.abs(groups[0].save_ms - 1200)).toBeLessThan(20);
	// one call's wait chopped by a sliver of CPU stays one link
	const one = find_parallelizable(timeline([wait(0, 300, 'timer'), cpu(300, 304), call(304, 600, 700), cpu(600, 602), call(602, 1004, 700)]));
	expect(one[0]?.calls).toEqual(['timer', 'GET /slow-io/api']);
});

test('short waits keep the strict line: 8 ms of CPU between 30 ms waits is work between them', () => {
	const groups = find_parallelizable(timeline([wait(0, 30, 'GET /user'), cpu(30, 38), wait(38, 63, 'GET /cart'), cpu(63, 71), wait(71, 91, 'GET /promos')]));
	expect(groups).toEqual([]);
});
