import { describe, it, expect } from 'vitest';
import { analyze_session, session_timeline } from '../src/devtools/session-insights.js';
import type { SessionData } from '../src/devtools/session.js';

const base = (over: Partial<SessionData> = {}): SessionData => ({
	from: 0,
	to: 5000,
	interactions: [],
	longtasks: [],
	frames: [],
	shifts: [],
	requests: [],
	mutations: [],
	mut_log: [],
	clicks: [],
	errors: [],
	heap: null,
	events: [],
	cpu: null,
	cpu_off: 'unsupported',
	page: '/x',
	...over
});
const names = (fp: string) => ({ a: 'Slow', b: 'Late', c: 'Churn' })[fp as 'a'] ?? fp;
const codes = (r: ReturnType<typeof analyze_session>) => r.findings.map((f) => f.code);

describe('analyze_session', () => {
	it("a failed island is one finding (hydrate-failed), not also ogygia's own console log of it", () => {
		const failed = { name: 'region.hydrate.failed', fp: 'a', message: 'boom\n\tin X.svelte', seq: 1, t: 10, v: 1, realm: 'client', domain: 'runtime' } as unknown as SessionData['events'][number];
		const log = { t: 11, message: 'console.error: [ogygia] hydration failed for x.js boom\n\tin <unknown>\n\tin X.svelte' };
		const own = { t: 12, message: 'TypeError: nope\n    at f (a.js:1)' };
		const r = analyze_session(base({ events: [failed], errors: [log, own] }), names, 'http://x/x');
		expect(r.findings.find((f) => f.code === 'hydrate-failed')?.message).toContain('Slow failed to hydrate: boom');
		// the page's own error stays, by its first line; ogygia's log of the failure is not repeated
		expect(r.findings.find((f) => f.code === 'errors')?.message).toBe('1 error: TypeError: nope.');
		// with only the log (no failure event in the session), the log is an error like any other
		expect(codes(analyze_session(base({ errors: [log] }), names, 'http://x/x'))).toContain('errors');
	});

	it('an interaction: its length is the longest event, its split the event that ran the handlers', () => {
		const r = analyze_session(
			base({
				interactions: [
					{ t: 100, name: 'pointerdown', duration: 260, input_delay: 0, processing: 1, presentation: 259, id: 7, target: 'button "slow"', fp: 'a', el: null },
					{ t: 102, name: 'click', duration: 255, input_delay: 1, processing: 250, presentation: 4, id: 7, target: 'button "slow"', fp: 'a', el: null }
				],
				frames: [{ t: 100, ms: 260, blocking: 210, scripts: [{ source: 'http://x/src/Slow.svelte', fn: 'spin', invoker: 'BUTTON.onclick', ms: 250 }] }]
			}),
			names,
			'http://x/p'
		);
		const f = r.findings.find((x) => x.code === 'slow-interaction')!;
		expect(f.severity).toBe('warn');
		expect(f.message).toContain('260 ms');
		expect(f.message).toContain('handlers 250 ms');
		expect(f.message).toContain('in Slow');
		expect(f.message).toContain('BUTTON.onclick'); // no sampler: the long animation frame names the script
	});

	it('repeated clicks are rage, a click with no effect is dead, a late answer is late', () => {
		const r = analyze_session(
			base({
				clicks: [
					{ t: 100, target: 'button "late"', fp: 'b', el: null },
					{ t: 300, target: 'button "late"', fp: 'b', el: null },
					{ t: 500, target: 'button "late"', fp: 'b', el: null },
					{ t: 2000, target: 'button "dead"', fp: null, el: null },
					{ t: 3000, target: 'button "notice"', fp: 'c', el: null }
				],
				mut_log: [
					{ t: 1600, fp: 'b' },
					{ t: 3900, fp: 'c' }
				]
			}),
			names,
			'http://x/p'
		);
		expect(codes(r)).toEqual(expect.arrayContaining(['rage-click', 'dead-click', 'late-feedback']));
		expect(r.findings.find((f) => f.code === 'dead-click')!.message).toContain('"dead"');
		expect(r.findings.find((f) => f.code === 'dead-click')!.message).not.toContain('"late"');
		expect(r.findings.find((f) => f.code === 'late-feedback')!.message).toContain('900 ms');
	});

	it('a click outside islands is not dead when the page changed (but not the islands other clicks hit)', () => {
		const r = analyze_session(
			base({
				clicks: [
					{ t: 100, target: 'a', fp: null, el: null },
					{ t: 150, target: 'b', fp: 'a', el: null }
				],
				mut_log: [{ t: 200, fp: 'a' }]
			}),
			names,
			'http://x/p'
		);
		// the only change was in the island the second click hit: the first click did nothing
		expect(r.findings.find((f) => f.code === 'dead-click')?.message).toContain('a');
	});

	it('requests: failed, slow, repeated', () => {
		const req = (url: string, ms = 20, status: number | null = 200) => ({ url, type: 'fetch', t: 10, ms, bytes: 100, status });
		const r = analyze_session(base({ requests: [req('http://x/api/a'), req('http://x/api/a'), req('http://x/api/a'), req('http://x/missing', 5, 404), req('http://x/slow', 1500)] }), names, 'http://x/p');
		expect(codes(r)).toEqual(expect.arrayContaining(['failed-requests', 'slow-requests', 'repeated-requests']));
		expect(r.findings.find((f) => f.code === 'repeated-requests')!.message).toContain('/api/a ×3');
	});

	it('shifts only count when no input caused them; churn names the island', () => {
		const r = analyze_session(
			base({
				shifts: [
					{ t: 10, value: 0.3, input: true, fp: 'a', el: null },
					{ t: 900, value: 0.05, input: false, fp: 'c', el: null }
				],
				mutations: [{ fp: 'c', count: 800, el: null }]
			}),
			names,
			'http://x/p'
		);
		const shift = r.findings.find((f) => f.code === 'unexpected-shift')!;
		expect(shift.message).toContain('CLS 0.05');
		expect(shift.message).toContain('in Churn');
		expect(r.findings.find((f) => f.code === 'dom-churn')!.message).toContain('Churn changed the DOM 800 times');
	});

	it("a request's own server split (Server-Timing): the upstream it waited on", () => {
		const r = analyze_session(
			base({
				requests: [
					{
						url: 'http://x/api/slow?ms=450',
						type: 'fetch',
						t: 10,
						ms: 470,
						bytes: 20,
						status: 200,
						server: [
							{ name: 'ssr', ms: 455, desc: 'SvelteKit render' },
							{ name: 'cpu', ms: 6, desc: 'process CPU while it ran' },
							{ name: 'net', ms: 450, desc: 'outbound (1)' },
							{ name: 'up1', ms: 450, desc: 'GET upstream.test/items' }
						]
					}
				]
			}),
			names,
			'http://x/p'
		);
		const f = r.findings.find((x) => x.code === 'server-time')!;
		expect(f.message).toContain('455 ms on the server');
		expect(f.message).toContain('waiting on 1 outbound call');
		expect(f.message).toContain('GET upstream.test/items 450 ms');
		expect(f.fix).toContain('waited');
		expect(r.requests[0]).toMatchObject({ server_ms: 455, net_ms: 450 });
	});

	it('the timeline puts everything on one clock, requests with their server part', () => {
		const lanes = session_timeline(
			base({
				from: 1000,
				to: 3000,
				clicks: [{ t: 1100, target: 'button "x"', fp: 'a', el: null }],
				interactions: [{ t: 1100, name: 'click', duration: 260, input_delay: 1, processing: 250, presentation: 9, id: 3, target: 'button "x"', fp: 'a', el: null }],
				longtasks: [{ t: 1105, ms: 250 }],
				requests: [{ url: 'http://x/api/y', type: 'fetch', t: 1400, ms: 460, bytes: 10, status: 200, server: [{ name: 'ssr', ms: 455, desc: '' }, { name: 'net', ms: 450, desc: 'outbound (1)' }] }]
			}),
			names
		);
		const by = Object.fromEntries(lanes.map((l) => [l.key, l.items]));
		expect(by.input.find((i) => i.tone === 'bad')).toMatchObject({ t0: 100, t1: 360 });
		expect(by.main[0]).toMatchObject({ t0: 105, t1: 355, tone: 'bad' });
		expect(by.net[0]).toMatchObject({ t0: 400, t1: 860, server: { ms: 455, up: 450 } });
		expect(by.net[0].label).toContain('server 455 ms, waiting 450 ms');
		expect(lanes.map((l) => l.key)).not.toContain('errors'); // empty lanes left out
	});

	it('a quiet session says nothing', () => {
		expect(analyze_session(base(), names, 'http://x/p').findings).toEqual([]);
	});
});
