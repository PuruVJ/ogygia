// Where inside a hot function its time lands (profiler/report.ts `hot_line_of`): the heaviest line,
// its code, and — when V8 inlined a call there — the function called. Builtins and methods are the
// line's own work, never the one to "look inside".
import { expect, test } from 'vitest';
import { hot_line_of } from '../src/profiler/report.js';

const src = (start: number, lines: string[]) => ({ start, lines });

test('a load blamed for an inlined callee: the line, and the call to look inside', () => {
	const load = {
		name: 'load',
		line: 64,
		self_ms: 100,
		lines: [{ line: 98, ms: 80 }, { line: 70, ms: 10 }],
		src: src(96, ['\tconst sorted = [...hits].sort(byName);', '\t// freshest first', '\tconst freshest = [...valid].sort((a, b) => newestReview(b.reviews) - newestReview(a.reviews)).slice(0, 5);'])
	};
	const spot = hot_line_of(load, new Set());
	expect(spot).toMatchObject({ line: 98, ms: 80, calls: 'newestReview' });
	// (the code, trimmed, clipped at 100 characters)
	expect(spot?.code.startsWith('const freshest = [...valid].sort(')).toBe(true);
	expect(spot!.code.length).toBeLessThanOrEqual(100);
});

test('a leaf’s own loop: the line, no callee (Math.max, new Date, a method are its own work)', () => {
	const leaf = { name: 'newestReview', line: 21, self_ms: 60, lines: [{ line: 23, ms: 50 }], src: src(21, ['export function newestReview(reviews) {', '\tlet best = 0;', '\tfor (const r of reviews) best = Math.max(best, new Date(r.at).getTime());']) };
	const spot = hot_line_of(leaf, new Set(['load']));
	expect(spot?.line).toBe(23);
	expect(spot?.calls).toBeUndefined();
});

test('no single line holds the time, or it is the first line, or no source: nothing said', () => {
	const f = { name: 'f', line: 10, self_ms: 100, src: src(10, ['function f() {', 'a();', 'b();']) };
	expect(hot_line_of({ ...f, lines: [{ line: 11, ms: 30 }] }, new Set())).toBeNull();
	expect(hot_line_of({ ...f, lines: [{ line: 10, ms: 90 }] }, new Set())).toBeNull();
	expect(hot_line_of({ ...f, src: undefined, lines: [{ line: 11, ms: 90 }] }, new Set())).toBeNull();
});
