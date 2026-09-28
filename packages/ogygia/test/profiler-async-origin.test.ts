import { describe, expect, it } from 'vitest';
import { analyze, type CpuProfile } from '../src/profiler/analyze.js';

// ─────────────────────────────────────────────────────────────────────────────
// ASYNC ORIGINS: a library's continuation after an `await` runs with no app frame on its stack.
// The analyzer charges it to the app function that entered that package nearest in time.
// ─────────────────────────────────────────────────────────────────────────────

const APP = 'file:///app/src/lib/ds.js';
const LIB = 'file:///app/node_modules/@acme/render/index.mjs';
const frame = (id: number, name: string, url: string, line: number, children: number[] = []) => ({
	id,
	callFrame: { functionName: name, scriptId: '1', url, lineNumber: line, columnNumber: 0 },
	hitCount: 0,
	children
});

describe('async origins', () => {
	it('library work after an await is charged to the app function that called into the library', () => {
		const profile: CpuProfile = {
			nodes: [
				frame(1, '(root)', '', -1, [2, 5, 7]),
				frame(2, 'processTags', APP, 9, [3]),
				frame(3, 'render', APP, 15, [4]),
				frame(4, 'renderToString', LIB, 40),
				// the continuation: no app frame above it
				frame(5, 'hydrateFactory', LIB, 11, [6]),
				frame(6, 'computeMode', LIB, 2041),
				frame(7, '(idle)', '', -1)
			],
			startTime: 0,
			endTime: 10_000,
			samples: [4, 6, 6, 6, 6, 5, 7],
			timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000, 1000]
		} as CpuProfile;
		const a = analyze(profile);
		const render = a.functions.find((f) => f.name === 'render')!;
		expect(render.async_ms).toBe(5);
		const rts = render.callees?.find((c) => c.name === 'renderToString');
		expect(rts).toMatchObject({ ms: 6, async_ms: 5 });
		// the caller above `render` gets nothing: the entry was render's, not processTags'
		expect(a.functions.find((f) => f.name === 'processTags')!.async_ms).toBeUndefined();
	});
});

describe('Node work the profiler asked for is overhead', () => {
	it('a node frame under a profiler frame (no app frame between) is profiler time; under app code it stays node', () => {
		const PROF = 'file:///app/node_modules/ogygia/dist/profiler/index.js';
		const profile: CpuProfile = {
			nodes: [
				frame(1, '(root)', '', -1, [2, 5]),
				frame(2, '#capture_window', PROF, 990, [3]),
				frame(3, 'post', 'node:inspector', 114, [4]),
				frame(4, 'dispatch', '', -1),
				// the profiler's render → the app → Node: the app's
				frame(5, 'fetch_render', PROF, 2600, [6]),
				frame(6, 'load', APP, 3, [7]),
				frame(7, 'dispatch', '', -1)
			],
			startTime: 0,
			endTime: 10_000,
			samples: [4, 4, 4, 7],
			timeDeltas: [1000, 1000, 1000, 1000]
		} as CpuProfile;
		const a = analyze(profile);
		const d = a.functions.filter((f) => f.name === 'dispatch');
		expect(d.map((f) => [f.category, f.self_ms])).toEqual([['node', 1]]);
		expect(a.overhead_ms).toBeGreaterThanOrEqual(3);
	});
});
