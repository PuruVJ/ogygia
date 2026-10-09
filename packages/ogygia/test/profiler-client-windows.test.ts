// The browser's CPU trace cut by island: each island's hydrate window gets what ran inside it, the
// long tasks outside every island get theirs, and the report's findings quote them by name.
import { expect, test } from 'vitest';
import { analyze } from '../src/profiler/analyze.ts';
import { self_profile_to_cpuprofile } from '../src/profiler/index.ts';
import { client_windows, window_profile } from '../src/profiler/client-windows.ts';
import { parse_visit } from '../src/profiler/visit.ts';
import { browser_findings, browser_page_report } from '../src/profiler/browser-findings.ts';

// a trace every 10 ms from 0 to 1000: render_rows (Heavy.svelte) in 100–220, tick (a page script) in 500–700
const trace = {
	resources: ['http://x/src/lib/Heavy.svelte', 'http://x/page'],
	frames: [
		{ name: 'render_rows', resourceId: 0, line: 11, column: 1 },
		{ name: 'tick', resourceId: 1, line: 16, column: 1 }
	],
	stacks: [{ frameId: 0 }, { frameId: 1 }],
	samples: Array.from({ length: 101 }, (_, i) => {
		const t = i * 10;
		return { timestamp: t, ...(t >= 100 && t < 220 ? { stackId: 0 } : t >= 500 && t < 700 ? { stackId: 1 } : {}) };
	})
};

const visit = parse_visit('/lab', {
	at: Date.now(),
	nav: { req_start: 0, res_start: 20, res_end: 30, load: 90 },
	paints: {},
	resources: [],
	longtasks: [
		{ t: 100, ms: 120 },
		{ t: 500, ms: 200 }
	],
	islands: [
		{ fp: 'aaaaaaaa11111111', entry: '/src/lib/Heavy.svelte', t0: 40, loaded: 90, turn: 100, done: 220 },
		{ fp: 'bbbbbbbb22222222', entry: '/src/lib/Quick.svelte', t0: 40, loaded: 90, turn: 230, done: 235 }
	],
	firsts: [],
	shifts: []
})!;

test('each island window and the long tasks outside them, by name', () => {
	const profile = self_profile_to_cpuprofile(trace)!;
	const w = client_windows(profile, visit, (p) => analyze(p));
	expect(Object.keys(w.islands)).toEqual(['aaaaaaaa11111111']); // Quick's 5 ms window is too short to say anything
	expect(w.islands.aaaaaaaa11111111.top[0].name).toBe('render_rows');
	expect(w.islands.aaaaaaaa11111111.ms).toBeGreaterThanOrEqual(100);
	expect(w.islands.aaaaaaaa11111111.top.some((f) => f.name === 'tick')).toBe(false);
	expect(w.outside.top[0].name).toBe('tick');
	expect(w.outside.ms).toBeGreaterThanOrEqual(180);

	const rows = [{ fp: 'aaaaaaaa11111111', entry: '/src/lib/Heavy.svelte', name: 'Heavy' }];
	const found = browser_findings(browser_page_report(visit, rows, w));
	expect(found.find((f) => f.code === 'long-hydrate')?.message).toContain('mostly render_rows (Heavy.svelte:11)');
	expect(found.find((f) => f.code === 'long-tasks')?.message).toContain('mostly tick (page:16)');
});

test('a window profile keeps only the samples inside it', () => {
	const profile = self_profile_to_cpuprofile(trace)!;
	const cut = window_profile(profile, [[500, 600]]);
	expect(cut.samples!.filter((s) => s !== 2).length).toBe(11); // 500, 510, …, 600
	expect(profile.samples!.filter((s) => s !== 2).length).toBe(32); // the original is untouched
});
