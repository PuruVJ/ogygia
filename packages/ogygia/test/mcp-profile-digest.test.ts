import { describe, expect, it } from 'vitest';
import { render_profile } from '../src/mcp.js';

// ─────────────────────────────────────────────────────────────────────────────
// The MCP digest of a profile is what an agent reads to fix the code: the slow patterns (with the
// code, the caller lines and the fix) and the exact lines come first, before the broad findings.
// ─────────────────────────────────────────────────────────────────────────────

describe('ogygia_profile digest', () => {
	it('leads with the patterns and the exact lines, code included', () => {
		const out = render_profile('http://x', {
			target: { page: '/hell', runs: [700, 720] },
			findings: [{ severity: 'warn', message: 'something broad' }],
			patterns: [
				{
					title: 'renderToString (@acme/ui) is called once per item',
					save_ms: 191,
					evidence: '382 ms inside @acme/ui; render ran 242 times',
					fix: 'Cache the result by input.',
					example: { before: 'a', after: 'b\nc' },
					sites: [
						{
							file: 'src/lib/ds-ssr.ts',
							line: 16,
							code: 'const render = (html) => ui(html);',
							via: [
								{
									file: 'src/lib/ds-ssr.ts',
									line: 46,
									code: 'el = await renderToString(tag);',
									in_loop: true
								}
							]
						}
					]
				},
				{
					title: 'Calls wait one after another instead of together',
					save_ms: 142,
					wait: true,
					evidence: '16 calls',
					fix: 'Promise.all',
					sites: []
				}
			],
			ledger: [
				{
					file: 'src/lib/ds-ssr.ts',
					line: 62,
					code: 'html = html.replace(tag, el);',
					cpu_ms: 185,
					alloc_bytes: 1.8e9,
					gc_ms: 53
				}
			]
		} as Parameters<typeof render_profile>[1]);
		const order = ['## Slow patterns', '## The exact lines', '## Findings'].map((h) =>
			out.indexOf(h)
		);
		expect(order.every((i) => i > 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		// per render: a CPU saving over two runs halves; a wait is one render already
		expect(out).toContain(
			'1. **renderToString (@acme/ui) is called once per item** — saves ~95.5ms per render'
		);
		expect(out).toContain(
			'← called from src/lib/ds-ssr.ts:46 (in a loop): `el = await renderToString(tag);`'
		);
		expect(out).toContain('saves ~142ms of waiting per render');
		expect(out).toContain('Example: `a` → `b c`');
		// per render: the sample has two runs, so the totals halve
		expect(out).toContain(
			'- src/lib/ds-ssr.ts:62 — 92.5ms CPU, 858.3 MB allocated, 26.5ms GC\n  `html = html.replace(tag, el);`'
		);
		expect(out).toContain('Fixing all of these takes ~');
	});

	it('every section is one render’s worth, like the render time next to it', () => {
		const out = render_profile('', {
			target: { page: '/p', runs: [100, 100, 100] },
			summary: { busy_ms: 150, window_ms: 600, busy_pct: 25 },
			budget: [{ label: 'your code', category: 'app', ms: 90 }],
			hot_functions: [{ name: 'crunch', category: 'app', self_ms: 60, file: 'a.ts', line: 1 }],
			components: [{ name: 'Row', instances: 10, self_ms: 30 }],
			findings: []
		} as Parameters<typeof render_profile>[1]);
		expect(out).toContain('CPU busy 50ms per render');
		expect(out).toContain('- your code: 30ms');
		expect(out).toContain('1. crunch — 20ms self');
		expect(out).toContain('- Row ×10 — 10ms self');
	});

	it("the plan opens with the report's forecast: code fixes, what keeping answers adds, overlaps named", () => {
		const out = render_profile('', {
			target: { page: '/p', runs: [300] },
			findings: [],
			patterns: [
				{
					kind: 'waits-in-a-row',
					title: 'Waits in a row',
					save_ms: 50,
					wait: true,
					fix: 'Promise.all.',
					sites: [{ file: 'r.ts', line: 3 }]
				}
			],
			forecast: {
				now_ms: 300,
				after_ms: 200,
				cpu_ms: 20,
				wait_ms: 50,
				delete_ms: 30,
				parts: [
					{
						title: 'Waits in a row',
						kind: 'waits-in-a-row',
						ms: 50,
						wait: true,
						with: ['Repeat request']
					}
				],
				answers: { after_ms: 120, wait_ms: 130, parts: [] },
				cache: true
			}
		} as Parameters<typeof render_profile>[1]);
		const plan = out.slice(out.indexOf('## Do this, in order'));
		expect(plan.split('\n')[1]).toBe(
			'Doing all of it: ~300ms → ~200ms per render (−33%: 20ms CPU, 50ms waiting, 30ms of work for unread data). Counted once: "Waits in a row" covers "Repeat request". Keeping the services\' answers between renders too (a freshness decision: only where a slightly stale answer is fine): ~120ms. A cached copy of the whole document is a separate lever, not counted.'
		);
		// said once: not again over the patterns
		expect(out.split('Doing all of it').length).toBe(2);
	});

	it('with a forecast: the plan follows its order, folds covered fixes in, and says the render after each step', () => {
		const out = render_profile('', {
			target: { page: '/p', runs: [300] },
			findings: [],
			patterns: [
				{
					kind: 'formatter-per-call',
					title: 'A formatter per call',
					save_ms: 40,
					fix: 'Build it once.',
					sites: [{ file: 'src/lib/f.ts', line: 9 }]
				},
				{
					kind: 'waits-in-a-row',
					title: 'Waits in a row',
					save_ms: 60,
					wait: true,
					fix: 'Promise.all.',
					sites: [{ file: 'r.ts', line: 3 }]
				},
				{
					kind: 'repeat-request',
					title: 'Repeat request',
					save_ms: 30,
					wait: true,
					fix: 'Share it.',
					sites: [{ file: 'r.ts', line: 3 }]
				},
				{
					kind: 'kept-per-render',
					title: 'Kept',
					kept_bytes: 20 * 1048576,
					save_ms: 0,
					fix: 'Bound it.',
					sites: [{ file: 'src/lib/c.ts', line: 1 }]
				},
				{
					kind: 'same-answer',
					title: 'Same answer',
					save_ms: 90,
					wait: true,
					fix: 'Cache it.',
					sites: [{ file: 'r.ts', line: 3 }]
				}
			],
			drill: {
				label: 'render',
				ms: 300,
				kind: 'render',
				children: [
					{
						label: 'newest',
						ms: 50,
						kind: 'cpu',
						at: 'src/lib/fmt.ts:23',
						fills: [{ key: 'freshest', read: false }]
					}
				]
			},
			forecast: {
				now_ms: 300,
				after_ms: 150,
				cpu_ms: 40,
				wait_ms: 60,
				delete_ms: 50,
				parts: [
					{
						title: 'Waits in a row',
						kind: 'waits-in-a-row',
						ms: 60,
						wait: true,
						after_ms: 240,
						with: ['Repeat request']
					},
					{
						title: 'Delete work for data nothing reads (freshest)',
						kind: 'unread-work',
						ms: 50,
						wait: false,
						after_ms: 190
					},
					{
						title: 'A formatter per call',
						kind: 'formatter-per-call',
						ms: 40,
						wait: false,
						after_ms: 150
					}
				]
			}
		} as Parameters<typeof render_profile>[1]);
		const plan = out
			.slice(
				out.indexOf('## Do this, in order'),
				out.indexOf('\n## ', out.indexOf('## Do this') + 5)
			)
			.trim()
			.split('\n')
			.slice(2);
		// a leak that grows 20 MB a render still leads; then the forecast's order, each with the running
		// render; the covered fix is folded in, not listed again; the freshness decision comes after
		expect(plan.map((l) => l.slice(0, l.indexOf('**', 5) + 2))).toEqual([
			'1. **Kept**',
			'2. **Waits in a row**',
			'3. **Delete work for data nothing reads**',
			'4. **A formatter per call**',
			'5. **Same answer**'
		]);
		expect(plan[1]).toContain(
			'Also covers: Repeat request. → ~240ms per render after this and the steps above.'
		);
		expect(plan[3]).toContain('→ ~150ms per render after this and the steps above.');
		expect(plan.some((l) => l.includes('**Repeat request**'))).toBe(false);
	});

	it("names the page's fixes that other profiled pages share, with what each gives back there", () => {
		const out = render_profile('', {
			target: { page: '/deals', runs: [100] },
			findings: [],
			shared: [
				{
					kind: 'scan-for-key',
					title: 'A key is found by walking every entry',
					where: 'src/lib/catalog.ts',
					line: 34,
					pages: [
						{ page: '/deals', ms: 46.4 },
						{ page: '/search', ms: 17.9 }
					],
					total_ms: 64.3
				}
			]
		} as Parameters<typeof render_profile>[1]);
		expect(out).toContain(
			'## These fixes make other pages faster too\n- `src/lib/catalog.ts:34` (A key is found by walking every entry): /deals ~46.4ms, /search ~17.9ms; ~64.3ms per render in all'
		);
	});

	it('opens with one ordered plan: patterns and work for nothing, by ms per render, each with the line to edit', () => {
		const out = render_profile('', {
			target: { page: '/p', runs: [300, 300] },
			findings: [],
			patterns: [
				{
					kind: 'formatter-per-call',
					title: 'A formatter per call',
					save_ms: 40,
					fix: 'Build it once. More text.',
					sites: [{ file: 'src/lib/f.ts', line: 9 }]
				},
				{
					kind: 'waits-in-a-row',
					title: 'Waits in a row',
					save_ms: 50,
					wait: true,
					fix: 'Promise.all.',
					sites: [
						{ file: 'src/lib/svc.ts', line: 3, via: [{ file: 'routes/+page.server.ts', line: 12 }] }
					]
				},
				// a small kept amount waits behind the time savings
				{
					kind: 'kept-per-render',
					title: 'Kept',
					kept_bytes: 2 * 1048576,
					save_ms: 0,
					fix: 'Bound it.',
					sites: [{ file: 'src/lib/c.ts', line: 1 }]
				},
				// inside work that goes away: moot
				{
					kind: 'date-parse',
					title: 'Dates parsed',
					save_ms: 60,
					fix: 'x',
					sites: [{ file: 'src/lib/fmt.ts', line: 23 }]
				}
			],
			drill: {
				label: 'render',
				ms: 300,
				kind: 'render',
				children: [
					{
						label: 'newest',
						ms: 30,
						kind: 'cpu',
						at: 'src/lib/fmt.ts:23',
						fills: [{ key: 'freshest', read: false }]
					}
				]
			}
		} as Parameters<typeof render_profile>[1]);
		const plan = out.slice(
			out.indexOf('## Do this, in order'),
			out.indexOf('\n## ', out.indexOf('## Do this') + 5)
		);
		expect(plan.trim().split('\n').slice(1)).toEqual([
			'1. **Waits in a row** — `routes/+page.server.ts:12` · ~50ms per render. Promise.all.',
			'2. **Delete work for data nothing reads** — newest (`src/lib/fmt.ts:23`) builds only freshest: ~30ms per render. Drop it from the load, or the key with it.',
			'3. **A formatter per call** — `src/lib/f.ts:9` · ~20ms per render. Build it once.',
			'4. **Kept** — `src/lib/c.ts:1` · keeps 2.0 MB alive per render. Bound it.'
		]);
		expect(out.indexOf('## Do this')).toBeLessThan(out.indexOf('## Slow patterns'));
	});

	it('a helper site is moot only when EVERY line that called it is in work that goes away', () => {
		const drill = {
			label: 'render',
			ms: 100,
			kind: 'render',
			children: [
				{
					label: 'GET api/live',
					ms: 20,
					kind: 'wait',
					fills: [{ key: 'live_at', read: false }],
					children: [{ label: 'l', ms: 20, kind: 'line', at: 'routes/x/+page.server.ts:75' }]
				}
			]
		};
		const pat = (via: number[]) => ({
			kind: 'waits-in-a-row',
			title: 'Waits',
			save_ms: 30,
			wait: true,
			fix: 'x.',
			sites: [
				{
					file: 'src/routes/x/+page.server.ts',
					line: 15,
					via: via.map((line) => ({ file: 'src/routes/x/+page.server.ts', line }))
				}
			]
		});
		const plan = (via: number[]) => {
			const out = render_profile('', {
				target: { page: '/x', runs: [100] },
				findings: [],
				patterns: [pat(via)],
				drill
			} as Parameters<typeof render_profile>[1]);
			const at = out.indexOf('## Do this');
			return out.slice(at, out.indexOf('\n## ', at + 5));
		};
		expect(plan([75])).not.toContain('**Waits**');
		expect(plan([67, 75])).toContain('**Waits**');
	});

	it('says what changed since the last profile of the page, first', () => {
		const out = render_profile('', {
			target: { page: '/x', runs: [94] },
			findings: [],
			since: {
				prev: 'a1',
				a_ms: 163,
				b_ms: 94.4,
				moved: [
					{
						path: ['load functions', 'load (x.ts:24)'],
						kind: 'line',
						at: 'x.ts:24',
						d_ms: -67.1,
						status: 'better'
					}
				],
				fix_check: { predicted_ms: 68.1, measured_ms: 68.6, verdict: 'as-expected' }
			}
		} as Parameters<typeof render_profile>[1]);
		expect(out).toContain(
			'## Since your last profile of this page\n-68.6ms since the last profile (163 → 94.4ms), mostly:\n- better load (x.ts:24): -67.1ms\nThe fixed patterns promised ~68.1ms; the render moved 68.6ms (as-expected).'
		);
	});

	it('an older report with no patterns or ledger renders as before', () => {
		const out = render_profile('', { target: { page: '/' }, findings: [] } as Parameters<
			typeof render_profile
		>[1]);
		expect(out).not.toContain('Slow patterns');
		expect(out).not.toContain('The exact lines');
	});
});
