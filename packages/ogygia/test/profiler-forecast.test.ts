import { describe, expect, it } from 'vitest';
import { forecast_of } from '../src/profiler/forecast.js';
import type { Pattern } from '../src/profiler/patterns.js';
import type { DrillNode } from '../src/profiler/drill.js';

// One render after every fix: a saving is never counted twice.

const pat = (
	o: Partial<Pattern> & Pick<Pattern, 'kind' | 'save_ms'>,
	sites: [string, number][],
	via: [string, number][] = []
): Pattern =>
	({
		title: o.kind,
		cost_ms: o.save_ms,
		alloc_bytes: 0,
		fix: '',
		evidence: '',
		...o,
		sites: sites.map(([file, line]) => ({
			file,
			path: file,
			line,
			code: '',
			cpu_ms: 0,
			...(via.length ? { via: via.map(([f, l]) => ({ file: f, line: l, code: '' })) } : {})
		}))
	}) as unknown as Pattern;

describe('forecast_of', () => {
	it('separate fixes add up; fixes on the same line count their biggest once', () => {
		const f = forecast_of(
			[100, 110, 120],
			[
				// CPU savings cover all 3 renders: 60 → 20 a render
				pat({ kind: 'formatter-per-call', save_ms: 60 }, [['lib/f.ts', 6]]),
				pat({ kind: 'library-per-item', save_ms: 30 }, [['lib/f.ts', 6]]),
				pat({ kind: 'date-parse', save_ms: 15 }, [['lib/d.ts', 2]]),
				// waits are one render's
				pat({ kind: 'waits-in-a-row', save_ms: 25, wait: true }, [['routes/+page.server.ts', 10]]),
				pat({ kind: 'same-answer', save_ms: 20, wait: true }, [['routes/+page.server.ts', 10]])
			],
			undefined
		)!;
		expect(f).toMatchObject({ now_ms: 110, cpu_ms: 25, wait_ms: 25, delete_ms: 0, after_ms: 60 });
		// biggest first, each with the render once it and every one above it are done
		expect(f.parts.map((p) => [p.kind, p.after_ms])).toEqual([
			['waits-in-a-row', 85],
			['formatter-per-call', 65],
			['date-parse', 60]
		]);
		expect(f.parts.find((p) => p.kind === 'formatter-per-call')?.with).toEqual([
			'library-per-item'
		]);
		// keeping the answer is a freshness decision: apart, on top of the code fixes, counted once
		// with the calls it shares a line with
		expect(f.parts.some((p) => p.kind === 'same-answer')).toBe(false);
		// (here keeping it saves no more than starting the calls together: no second figure)
		expect(f.answers).toBeUndefined();
		const bigger = forecast_of(
			[100],
			[
				pat({ kind: 'waits-in-a-row', save_ms: 25, wait: true }, [['r.ts', 10]]),
				pat({ kind: 'same-answer', save_ms: 40, wait: true }, [['r.ts', 10]])
			],
			undefined
		)!;
		expect(bigger).toMatchObject({
			after_ms: 75,
			wait_ms: 25,
			answers: { after_ms: 60, wait_ms: 40 }
		});
		expect(bigger.answers!.parts[0]).toMatchObject({
			kind: 'same-answer',
			with: ['waits-in-a-row']
		});
	});

	it("a line's CPU and its wait are different time: both count", () => {
		const f = forecast_of(
			[100],
			[
				pat({ kind: 'deep-copy', save_ms: 10 }, [['a.ts', 1]]),
				pat({ kind: 'same-answer', save_ms: 20, wait: true }, [['a.ts', 1]])
			],
			undefined
		)!;
		expect(f.after_ms).toBe(90);
		expect(f.answers?.after_ms).toBe(70);
	});

	it('keeping the answers, measured: the render served them, less the code fixes the caching does not cover', () => {
		const pats = [
			// covered by the caching (same line): already in the measured render
			pat({ kind: 'waits-in-a-row', save_ms: 25, wait: true }, [['r.ts', 10]]),
			pat({ kind: 'same-answer', save_ms: 40, wait: true }, [['r.ts', 10]]),
			// elsewhere: comes off the measured render too
			pat({ kind: 'deep-copy', save_ms: 10 }, [['a.ts', 1]])
		];
		const f = forecast_of([100], pats, undefined, { answers_runs: [52, 48, 50] })!;
		// the lines alone: 100 − 40 − 10 = 50; the page served the answers rendered in 50 (median)
		expect(f.after_ms).toBe(65);
		expect(f.answers).toMatchObject({ after_ms: 40, measured: { ms: 50, renders: 3, model_ms: 50 } });
		// no measured renders: the estimate, as before
		expect(forecast_of([100], pats, undefined)!.answers).toMatchObject({ after_ms: 50 });
		expect(forecast_of([100], pats, undefined)!.answers?.measured).toBeUndefined();
	});

	it('work for data nothing reads is deleted, and a pattern inside it is moot', () => {
		const drill: DrillNode = {
			label: 'render',
			ms: 100,
			kind: 'render',
			children: [
				{
					label: 'load',
					ms: 100,
					kind: 'phase',
					children: [
						{
							label: 'build sitemap',
							ms: 30,
							kind: 'cpu',
							fills: [{ key: 'sitemap', read: false }],
							children: [{ label: 'x', ms: 30, kind: 'line', at: 'src/lib/html.ts:13' }]
						}
					]
				}
			]
		};
		const f = forecast_of(
			[100],
			[
				pat({ kind: 'string-build', save_ms: 20 }, [['lib/html.ts', 13]]),
				pat({ kind: 'date-parse', save_ms: 5 }, [['lib/d.ts', 2]])
			],
			drill
		)!;
		expect(f).toMatchObject({ delete_ms: 30, cpu_ms: 5, after_ms: 65 });
		expect(f.parts.map((p) => p.kind)).toEqual(['unread-work', 'date-parse']);
	});

	it('deleting one call of a chain that runs together anyway saves nothing more: one group', () => {
		// GET session ← svc line 17 ← localeOf line 31 ← load line 80 (feeds only `locale`, unread)
		const drill: DrillNode = {
			label: 'render',
			ms: 100,
			kind: 'render',
			children: [
				{
					label: 'GET session',
					ms: 30,
					kind: 'wait',
					children: [
						{
							label: 'svc',
							ms: 30,
							kind: 'line',
							at: 'src/routes/p.ts:17',
							children: [
								{ label: 'currentUser', ms: 15, kind: 'line', at: 'src/routes/p.ts:28' },
								{
									label: 'localeOf',
									ms: 15,
									kind: 'line',
									at: 'src/routes/p.ts:31',
									children: [
										{
											label: 'load',
											ms: 15,
											kind: 'line',
											at: 'src/routes/p.ts:80',
											fills: [{ key: 'locale', read: false }]
										}
									]
								}
							]
						}
					]
				}
			]
		};
		const f = forecast_of(
			[100],
			[
				pat(
					{ kind: 'waits-in-a-row', save_ms: 20, wait: true },
					[['routes/p.ts', 17]],
					[
						['routes/p.ts', 28],
						['routes/p.ts', 31]
					]
				)
			],
			drill
		)!;
		expect(f).toMatchObject({ wait_ms: 20, delete_ms: 0, after_ms: 80 });
		expect(f.parts[0].with).toEqual(['Delete work for data nothing reads (locale)']);
	});

	it('two unread calls under one shared helper line are two deletions (both count); a fix on that line still joins them', () => {
		const drill: DrillNode = {
			label: 'render',
			ms: 100,
			kind: 'render',
			children: [
				{
					label: 'GET /svc',
					ms: 60,
					kind: 'wait',
					children: [
						{
							label: 'svc',
							ms: 60,
							kind: 'line',
							at: 'src/lib/svc.ts:10',
							children: [
								{
									label: 'a',
									ms: 30,
									kind: 'line',
									at: 'src/routes/p.ts:5',
									fills: [{ key: 'a', read: false }]
								},
								{
									label: 'b',
									ms: 30,
									kind: 'line',
									at: 'src/routes/p.ts:6',
									fills: [{ key: 'b', read: false }]
								}
							]
						}
					]
				}
			]
		};
		expect(forecast_of([100], [], drill)).toMatchObject({ delete_ms: 60, after_ms: 40 });
		// a wait fix on the helper line: one group with both (its biggest saving)
		const f = forecast_of(
			[100],
			[pat({ kind: 'waits-in-a-row', save_ms: 70, wait: true }, [['lib/svc.ts', 10]])],
			drill
		)!;
		expect(f.after_ms).toBe(30);
	});

	it('the same unread data in several rows is one deletion: its rows add up', () => {
		const drill: DrillNode = {
			label: 'render',
			ms: 100,
			kind: 'render',
			children: [
				{
					label: 'newestReview',
					ms: 50,
					kind: 'cpu',
					at: 'src/lib/format.ts:23',
					fills: [{ key: 'freshest', read: false }]
				},
				{
					label: 'load',
					ms: 2,
					kind: 'cpu',
					at: 'src/routes/p.ts:64',
					children: [
						{
							label: 'p:98',
							ms: 1,
							kind: 'line',
							at: 'src/routes/p.ts:98',
							fills: [{ key: 'freshest', read: false }]
						}
					]
				},
				{
					label: 'garbage collection',
					ms: 1,
					kind: 'cpu',
					children: [
						{
							label: 'p:98',
							ms: 0.5,
							kind: 'line',
							at: 'src/routes/p.ts:98',
							fills: [{ key: 'freshest', read: false }]
						}
					]
				}
			]
		};
		const f = forecast_of([100], [], drill)!;
		expect(f.parts).toEqual([
			{
				title: 'Delete work for data nothing reads (freshest)',
				kind: 'unread-work',
				ms: 51.5,
				wait: false,
				after_ms: 48.5
			}
		]);
	});

	it('a fix inside a function the deleted line calls (inlined onto it) joins the deletion', () => {
		const drill: DrillNode = {
			label: 'render',
			ms: 100,
			kind: 'render',
			children: [
				{
					label: 'load',
					ms: 60,
					kind: 'cpu',
					at: 'src/routes/p.ts:64',
					children: [
						{
							label: 'p:98',
							ms: 55,
							kind: 'line',
							at: 'src/routes/p.ts:98',
							code: 'const freshest = [...valid].sort((a, b) => newestReview(b.reviews) - newestReview(a.reviews));',
							fills: [{ key: 'freshest', read: false }]
						}
					]
				}
			]
		};
		const dates = pat({ kind: 'date-parse', save_ms: 30 }, [['lib/format.ts', 23]]);
		dates.sites[0].fn_name = 'newestReview';
		const f = forecast_of([100], [dates], drill)!;
		expect(f).toMatchObject({ delete_ms: 55, cpu_ms: 0, after_ms: 45 });
	});

	it('each resource is capped by what the render used: waiting (deleted waits too) and CPU', () => {
		// a deleted wait and a wait fix: together no more than the render waited
		const drill: DrillNode = {
			label: 'render',
			ms: 100,
			kind: 'render',
			children: [
				{
					label: 'GET /live',
					ms: 20,
					kind: 'wait',
					children: [
						{
							label: 'x',
							ms: 20,
							kind: 'line',
							at: 'r.ts:9',
							fills: [{ key: 'live_at', read: false }]
						}
					]
				}
			]
		};
		const w = forecast_of(
			[100],
			[pat({ kind: 'waits-in-a-row', save_ms: 40, wait: true }, [['r.ts', 5]])],
			drill,
			{ wait_cap: 45 }
		)!;
		expect(w).toMatchObject({ clamped: true, after_ms: 55 });
		expect(w.wait_ms + w.delete_ms).toBeCloseTo(45, 0);
		// CPU savings: no more than the render's CPU
		const c = forecast_of(
			[100],
			[
				pat({ kind: 'deep-copy', save_ms: 50 }, [['a.ts', 1]]),
				pat({ kind: 'date-parse', save_ms: 30 }, [['b.ts', 1]])
			],
			undefined,
			{ cpu_cap: 60 }
		)!;
		expect(c).toMatchObject({ clamped: true, cpu_ms: 60, after_ms: 40 });
		// within both: nothing held back
		expect(
			forecast_of([100], [pat({ kind: 'deep-copy', save_ms: 50 }, [['a.ts', 1]])], undefined, {
				cpu_cap: 60
			})
		).toMatchObject({ after_ms: 50 });
	});

	it('a whole-document cache is a separate lever; waits are capped at the waiting; never the whole render', () => {
		const f = forecast_of(
			[100],
			[
				pat({ kind: 'same-document', save_ms: 100 }, [['r.ts', 1]]),
				pat({ kind: 'waits-in-a-row', save_ms: 50, wait: true }, [['r.ts', 5]])
			],
			undefined,
			{ wait_cap: 30 }
		)!;
		expect(f).toMatchObject({ cache: true, wait_ms: 30, after_ms: 70 });
		const big = forecast_of(
			[100],
			[
				pat({ kind: 'deep-copy', save_ms: 80 }, [['a.ts', 1]]),
				pat({ kind: 'date-parse', save_ms: 50 }, [['b.ts', 1]])
			],
			undefined
		)!;
		// (no caps given: only the last guard, what serves the page stays)
		expect(big).toMatchObject({ clamped: true, after_ms: 3 });
		expect(forecast_of(undefined, [], undefined)).toBeUndefined();
		expect(forecast_of([100], [], undefined)).toBeUndefined();
	});

	it('a fix inside a call another fix moves out of the request saves nothing more: one group', () => {
		const mover = pat({ kind: 'same-every-request', save_ms: 60 }, [['routes/p.ts', 9]]);
		mover.sites[0].fn_name = 'attachBrands';
		// its function IS the moved call
		const own = pat({ kind: 'lookup-in-loop', save_ms: 20 }, [['lib/c.ts', 16]]);
		own.sites[0].fn_name = 'attachBrands';
		// an arrow inside it: the stacks say it runs under attachBrands
		const arrow = pat({ kind: 'spread-accumulate', save_ms: 10 }, [['lib/c.ts', 17]]);
		arrow.sites[0].fn = 'arrow-17';
		// elsewhere: still its own saving
		const other = pat({ kind: 'date-parse', save_ms: 5 }, [['lib/d.ts', 2]]);
		other.sites[0].fn = 'other';
		const stacks = (k: string) =>
			k === 'arrow-17'
				? [
						{ ms: 9.5, frames: [{ n: 'attachBrands', f: 'lib/c.ts:13', c: 'app' as const }] },
						{ ms: 0.5, frames: [] }
					]
				: k === 'other'
					? [{ ms: 5, frames: [{ n: 'render', f: 'x.svelte:1', c: 'app' as const }] }]
					: undefined;
		const f = forecast_of([100], [mover, own, arrow, other], undefined, { stacks })!;
		expect(f).toMatchObject({ cpu_ms: 65, after_ms: 35 });
		expect(f.parts.find((p) => p.kind === 'same-every-request')?.with?.sort()).toEqual([
			'lookup-in-loop',
			'spread-accumulate'
		]);
	});

	it('patterns joined through a caller line (a helper) are one group', () => {
		const f = forecast_of(
			[100],
			[
				pat(
					{ kind: 'same-answer', save_ms: 20, wait: true },
					[['lib/api.ts', 3]],
					[['routes/p.ts', 9]]
				),
				pat({ kind: 'waits-in-a-row', save_ms: 30, wait: true }, [['routes/p.ts', 9]])
			],
			undefined
		)!;
		expect(f.wait_ms).toBe(30);
	});
});
