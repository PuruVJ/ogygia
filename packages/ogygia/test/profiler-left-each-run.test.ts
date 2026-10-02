// A timer each render starts and never ends (profiler/async-io.ts `mark_left_each_run`): the same line,
// still open, in every run — never a process-wide timer started once, a short or unref'd timeout, or
// a single render.
import { expect, test } from 'vitest';
import { mark_left_each_run, type IoOp } from '../src/profiler/async-io.js';

const runs = [
	{ start: 0, end: 100 },
	{ start: 200, end: 300 },
	{ start: 400, end: 500 }
];
const site = (line: number) => ({ fn: 'f', file: '/app/+page.server.ts', line, column: 3 });
const timer = (start: number, line: number, more: Partial<IoOp> = {}): IoOp => ({ type: 'Timeout', start, ms: 1, open: true, caller_site: site(line), ...more });

test('the same line left open in every run: marked; one started once, a short or unref’d timeout: not', () => {
	const ops = [
		...[10, 210, 410].map((t) => timer(t, 9, { repeat: 1000 })),
		...[11, 211, 411].map((t) => timer(t, 15, { delay: 30_000 })),
		// a process-wide interval: the first render only
		timer(12, 20, { repeat: 5000 }),
		// short timeouts, and unref'd ones (Node's AbortSignal.timeout behind a fetch)
		...[13, 213, 413].map((t) => timer(t, 25, { delay: 200 })),
		...[14, 214, 414].map((t) => timer(t, 30, { delay: 5000, unref: true })),
		// cleared (not open)
		...[15, 215, 415].map((t) => timer(t, 35, { repeat: 1000, open: undefined }))
	];
	mark_left_each_run(ops, runs);
	expect([...new Set(ops.filter((o) => o.left_each_run).map((o) => o.caller_site!.line))]).toEqual([9, 15]);
});

test('one render proves nothing', () => {
	const ops = [timer(10, 9, { repeat: 1000 })];
	mark_left_each_run(ops, runs.slice(0, 1));
	expect(ops[0].left_each_run).toBeUndefined();
});
