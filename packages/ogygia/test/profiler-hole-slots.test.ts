import { describe, expect, it } from 'vitest';
import { hole_slots } from '../src/profiler/hole-slots.js';
import type { RequestEntry } from '../src/profiler/report.js';

const req = (ms: number, hole?: RequestEntry['hole'], og?: RequestEntry['og']): RequestEntry =>
	({ ts: 0, method: 'GET', path: '/x', route: null, status: 200, ms, cpu_ms: 0, inflight: 0, net_ms: 0, net_count: 0, ...(hole ? { hole } : {}), ...(og ? { og } : {}) }) as RequestEntry;
const hole = (id: string, queue_ms?: number, cache: 'hit' | 'miss' | 'none' = 'none') => ({ kind: 'hole' as const, id, cache, ttl: 0, ...(queue_ms !== undefined ? { queue_ms } : {}) });

describe('hole_slots', () => {
	it('no hole requests: nothing to say', () => {
		expect(hole_slots([req(20)])).toBeNull();
	});

	it('names who held the slots the queued holes waited for, render counted without the wait', () => {
		const page = req(40, undefined, { hole_rows: [{ id: 'slow', name: 'SlowHole', props: '{"n":1}', when: 'load', hydrate: null, ttl: 0, count: 1 }] } as never);
		const ring = [
			page,
			req(900, hole('slow', 0)),
			req(900, hole('slow', 0)),
			req(900, hole('slow', 0)),
			req(900, hole('slow', 0)),
			// the fifth waited 880 ms for a slot, then rendered in 900
			req(1780, hole('slow', 880)),
			req(30, hole('quick', 0)),
			req(2, hole('quick', undefined, 'hit'))
		];
		const s = hole_slots(ring)!;
		expect(s.rendered).toBe(6);
		expect(s.queued).toBe(1);
		const slow = s.rows[0];
		expect(slow.name).toBe('SlowHole {"n":1}');
		expect(slow.render_ms).toBe(900);
		expect(slow.queue_max_ms).toBe(880);
		expect(slow.slot_share).toBeGreaterThan(0.99);
		const quick = s.rows.find((r) => r.id === 'quick')!;
		expect(quick.hits).toBe(1);
		expect(quick.render_ms).toBe(30);
		expect(s.summary).toContain('1 of 6 hole renders waited for a render slot, 880 ms on average');
		expect(s.summary).toContain('held mostly by SlowHole {"n":1} (99% of slot time, 900 ms a render)');
		expect(s.summary).toContain('renders 4 holes at a time');
	});

	it('a failed render is no render time; a hole with no page row is named by the endpoint', () => {
		const s = hole_slots([
			{ ...req(0.5, { ...hole('b'), name: 'BrokenHole' }), status: 500 },
			req(300, { ...hole('g', 0), name: 'Greeting' })
		])!;
		const broken = s.rows.find((r) => r.id === 'b')!;
		expect(broken).toMatchObject({ name: 'BrokenHole', failed: 1, render_ms: 0 });
		expect(s.rows.find((r) => r.id === 'g')!.name).toBe('Greeting');
		expect(s.rendered).toBe(1);
	});

	it('several copies of one hole (different props): the component alone', () => {
		const rows = [1, 2].map((n) => ({ id: 'q', name: 'QueueHole', props: `{"n":${n}}`, when: 'load', hydrate: null, ttl: 0, count: 1 }));
		const s = hole_slots([req(40, undefined, { hole_rows: rows } as never), req(900, hole('q', 0))])!;
		expect(s.rows[0].name).toBe('QueueHole');
	});

	it('one request per instance (nothing queued): the table without a summary', () => {
		const s = hole_slots([req(900, hole('a', 0)), req(40, hole('b'))])!;
		expect(s.queued).toBe(0);
		expect(s.summary).toBeNull();
		expect(s.rows.map((r) => r.id)).toEqual(['a', 'b']);
	});
});
