import { describe, expect, it } from 'vitest';
import { varied_answers, find_same_answers } from '../src/profiler/patterns.js';

// An answer the same every render but for a stamp (a generation time, a request id): as cacheable as
// an unchanging one.

describe('almost the same answer', () => {
	it('the GETs made in every render with more than one answer', () => {
		const runs = [
			{ start: 0, end: 10 },
			{ start: 10, end: 20 }
		];
		const c = (url: string, start: number, body_hash: string) => ({ method: 'GET', url, status: 200, start, body_hash });
		const calls = [c('/a', 1, 'x'), c('/a', 11, 'y'), c('/b', 1, 'z'), c('/b', 11, 'z'), c('/c', 1, 'p')];
		expect([...varied_answers(calls, runs)]).toEqual(['GET /a']);
	});

	it('its own kind, what changes quoted, a caching lever like the same answer', () => {
		const at = { path: '/app/src/routes/+page.server.ts', line: 4 };
		const p = find_same_answers({
			calls: [{ start: 0, ms: 30, target: 'GET api/catalog', exact: 'GET /api/catalog', at }],
			stable: new Set(['GET /api/catalog']),
			almost: new Map([['GET /api/catalog', '"generatedAt":"2026-09-27T09:00:01.123Z"']])
		})!;
		expect(p.kind).toBe('almost-same-answer');
		expect(p.title).toBe('Almost the same answer is fetched on every render');
		expect(p.fix).toContain('generatedAt');
		expect(p.save_ms).toBe(30);
		expect(p.wait).toBe(true);
	});
});
