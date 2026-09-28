import { describe, expect, it } from 'vitest';
import { redisStore } from '../src/profiler/storage/redis.js';

// ─────────────────────────────────────────────────────────────────────────────
// The Redis store against two in-memory clients shaped like node-redis (camelCase, options objects)
// and ioredis (lowercase, positional arguments): the prefix, the caps, the index sets that drop
// expired ids, and one round trip per write on either flavour.
// ─────────────────────────────────────────────────────────────────────────────

function fake(flavour: 'node' | 'io') {
	const kv = new Map<string, string>();
	const z = new Map<string, Map<string, number>>();
	const calls: string[] = [];
	const zset = (k: string) => z.get(k) ?? z.set(k, new Map()).get(k)!;
	const range = (k: string, a: number, b: number, rev: boolean) => {
		const members = [...zset(k)].sort((x, y) => x[1] - y[1]).map(([m]) => m);
		if (rev) members.reverse();
		const n = members.length;
		const s = a < 0 ? n + a : a;
		const e = b < 0 ? n + b : b;
		return members.slice(Math.max(0, s), Math.max(0, e + 1));
	};
	const base = {
		async get(k: string) {
			calls.push('get');
			return kv.get(k) ?? null;
		},
		async del(k: string | string[]) {
			calls.push('del');
			for (const x of Array.isArray(k) ? k : [k]) kv.delete(x);
		}
	};
	const client =
		flavour === 'node'
			? {
					...base,
					async set(k: string, v: string, o?: { EX: number }) {
						calls.push(o ? `set EX ${o.EX}` : 'set');
						if (o !== undefined && typeof o !== 'object') throw new Error('node-redis takes an options object');
						kv.set(k, v);
					},
					async zAdd(k: string, m: { score: number; value: string }) {
						calls.push('zadd');
						zset(k).set(m.value, m.score);
					},
					async zRem(k: string, m: string | string[]) {
						calls.push('zrem');
						for (const x of Array.isArray(m) ? m : [m]) zset(k).delete(x);
					},
					async zRange(k: string, a: number, b: number, o?: { REV: true }) {
						calls.push('zrange');
						return range(k, a, b, !!o?.REV);
					},
					async zCard(k: string) {
						calls.push('zcard');
						return zset(k).size;
					}
				}
			: {
					...base,
					async set(k: string, v: string, ...rest: unknown[]) {
						calls.push(rest.length ? `set ${rest.join(' ')}` : 'set');
						if (rest.length && typeof rest[0] === 'object') throw new Error('ERR syntax error');
						kv.set(k, v);
					},
					async zadd(k: string, score: number, member: string) {
						calls.push('zadd');
						zset(k).set(member, score);
					},
					async zrem(k: string, ...m: string[]) {
						calls.push('zrem');
						for (const x of m) zset(k).delete(x);
					},
					async zrange(k: string, a: number, b: number, rev?: string) {
						calls.push('zrange');
						return range(k, a, b, rev === 'REV');
					},
					async zcard(k: string) {
						calls.push('zcard');
						return zset(k).size;
					}
				};
	return { client, kv, z, calls };
}

const rec = (id: string, created: number) => ({ id, created, page: '/p', trigger: 'page', label: '/p', median: 10, dump: `{"id":"${id}"}` });

describe('redis store', () => {
	for (const flavour of ['node', 'io'] as const) {
		it(`${flavour}: the prefix names every key, and a TTL write is one SET`, async () => {
			const f = fake(flavour);
			const s = redisStore(f.client as never, { prefix: 'app1:', ttlSeconds: 60 });
			await s.putReport(rec('a', 1));
			expect([...f.kv.keys()]).toEqual(['app1:report:a']);
			expect([...f.z.keys()]).toEqual(['app1:reports']);
			// one set, in the client's own form (no rejected first try)
			expect(f.calls.filter((c) => c.startsWith('set'))).toEqual([flavour === 'node' ? 'set EX 60' : 'set EX 60']);
			expect(await s.getReport('a')).toBe('{"id":"a"}');
		});

		it(`${flavour}: an expired report's id leaves the index when the list is read`, async () => {
			const f = fake(flavour);
			const s = redisStore(f.client as never);
			await s.putReport(rec('a', 1));
			await s.putReport(rec('b', 2));
			f.kv.delete('og:report:a'); // the TTL ran out
			expect((await s.listReports()).map((r) => r.id)).toEqual(['b']);
			expect([...f.z.get('og:reports')!.keys()]).toEqual(['b']);
		});

		it(`${flavour}: prune keeps the newest, and visits are capped per page`, async () => {
			const f = fake(flavour);
			const s = redisStore(f.client as never);
			for (let i = 0; i < 5; i++) await s.putReport(rec('r' + i, i));
			await s.prune!(2);
			expect((await s.listReports()).map((r) => r.id)).toEqual(['r4', 'r3']);
			expect(f.kv.has('og:report:r0')).toBe(false);
			for (let i = 0; i < 30; i++) await s.putVisit!({ key: `/p\0${i}`, page: '/p', at: i, visit: '{}' });
			expect(f.z.get('og:visit:z:/p')!.size).toBe(20);
			expect((await s.listVisits!('/p', 3)).map((v) => v.at)).toEqual([29, 28, 27]);
			expect(f.kv.has('og:visit:/p\u00000')).toBe(false);
		});
	}
});
