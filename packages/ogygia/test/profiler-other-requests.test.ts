import { describe, expect, it } from 'vitest';
import { analyze, route_dirs, route_file_of, type CpuProfile } from '../src/profiler/analyze.js';

// The sampler hears the whole process: another visitor's page answered while the profiled one
// rendered must not read as the profiled page's code.

const frame = (functionName: string, url = '', lineNumber = 0) => ({ functionName, url, lineNumber, columnNumber: 0 });

describe('route files', () => {
	it('a page or layout file, by its folder, in source or built form', () => {
		expect(route_file_of('/app/src/routes/latecomer/+page.server.ts')).toEqual({ dir: 'latecomer', page: true, form: 'src' });
		expect(route_file_of('/app/src/routes/+layout.svelte')).toEqual({ dir: '', page: false, form: 'src' });
		expect(route_file_of('/app/.svelte-kit/output/server/entries/pages/p/_id_/_page.svelte.js')).toEqual({ dir: 'p/_id_', page: true, form: 'built' });
		expect(route_file_of('/app/src/routes/api/+server.ts')).toBeUndefined();
		expect(route_file_of('/app/src/lib/helpers.ts')).toBeUndefined();
	});
	it("a route's own folder and the ones above it (their layouts are its)", () => {
		const d = route_dirs('/(app)/p/[id]');
		expect(d.own('src')).toBe('(app)/p/[id]');
		expect(d.own('built')).toBe('(app)/p/_id_');
		expect(d.above('src')).toEqual(['', '(app)', '(app)/p', '(app)/p/[id]']);
	});
});

describe('another visitor on the same page', () => {
	it('the samples of a render they overlapped are set aside by time, the clean render counts', () => {
		// 4 samples of 5 ms: two in the clean render (0–10 ms), two in the overlapped one (10–20 ms)
		const prof: CpuProfile = {
			startTime: 0,
			endTime: 20_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('load', 'file:///app/src/routes/p/+page.server.ts', 5), positionTicks: [{ line: 6, ticks: 4 }] }
			],
			samples: [2, 2, 2, 2],
			timeDeltas: [5000, 5000, 5000, 5000]
		};
		const a = analyze(prof, undefined, undefined, {
			perf_start: 100,
			window: { start: 100, end: 110 },
			calls: [],
			set_aside: [{ start: 110.5, end: 121 }]
		});
		const load = a.functions.find((f) => f.name === 'load')!;
		expect(load.self_ms).toBe(10);
		// its line keeps only the clean render's share
		expect(load.lines).toEqual([{ line: 6, ms: 10 }]);
		expect(a.other_requests_ms).toBe(10);
	});
});

describe('another request in the window', () => {
	it("its route's code, and everything under it, is set aside; the profiled route's, its layouts' and shared code stay", () => {
		const prof: CpuProfile = {
			startTime: 0,
			endTime: 40_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2, 3, 5, 6] },
				// ours
				{ id: 2, callFrame: frame('load', 'file:///app/src/routes/latecomer/+page.server.ts', 5) },
				// another page's load, and a shared helper it calls
				{ id: 3, callFrame: frame('load', 'file:///app/src/routes/purgatory/+page.server.ts', 18), children: [4] },
				{ id: 4, callFrame: frame('priceOf', 'file:///app/src/lib/helpers.ts', 6) },
				// the root layout: shared by both, stays
				{ id: 5, callFrame: frame('_layout', 'file:///app/src/routes/+layout.svelte', 0) },
				// shared code with no route frame above it: stays (no way to tell)
				{ id: 6, callFrame: frame('format', 'file:///app/src/lib/format.ts', 2) }
			],
			samples: [2, 3, 4, 4, 5, 6],
			timeDeltas: [5000, 5000, 5000, 5000, 5000, 5000]
		};
		const a = analyze(prof, undefined, undefined, {
			perf_start: 0,
			window: { start: 0, end: 40 },
			calls: [],
			route: '/latecomer'
		});
		const names = a.functions.filter((f) => f.category === 'app' || f.category === 'component').map((f) => f.url);
		expect(names.some((u) => u.includes('purgatory'))).toBe(false);
		expect(names.some((u) => u.includes('helpers.ts'))).toBe(false);
		expect(names.some((u) => u.includes('latecomer'))).toBe(true);
		expect(names.some((u) => u.includes('format.ts'))).toBe(true);
		expect(a.other_requests_ms).toBe(15);
		// without the route: as before, everything counts
		const b = analyze(prof, undefined, undefined, { perf_start: 0, window: { start: 0, end: 40 }, calls: [] });
		expect(b.functions.some((f) => f.url.includes('purgatory'))).toBe(true);
		expect(b.other_requests_ms).toBeUndefined();
	});
});
