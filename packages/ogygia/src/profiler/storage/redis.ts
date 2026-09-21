/**
 * Redis report store — for a fleet that already runs Redis, or a serverless deployment using a
 * hosted Redis (Upstash, ElastiCache). Reports are strings under `og:report:<id>`, a sorted set
 * `og:reports` (score = created ms) drives the list and the LRU prune, and visits mirror that.
 *
 *   import { redisStore } from 'ogygia/profiler/storage';
 *   // pass a connection string (node-redis / ioredis is imported on demand)…
 *   ogygia.profiler({ store: redisStore('redis://localhost:6379') });
 *   // …or an already-connected client (node-redis or ioredis both work)
 *   ogygia.profiler({ store: redisStore(myClient) });
 *
 * A TTL (seconds) expires reports on their own — handy on a shared instance where you only want the
 * last day of recordings.
 */
import type { ProfilerStore, ProfilerRecord, ProfilerSummary, ProfilerVisitRecord } from './index.js';

/** The subset of a Redis client this store uses — node-redis and ioredis both satisfy it (their
 *  method names match; only the multi-arg vs options shapes differ, handled below). */
interface RedisLike {
	set(key: string, val: string, ...rest: unknown[]): Promise<unknown>;
	get(key: string): Promise<string | null>;
	del(key: string | string[]): Promise<unknown>;
	zadd(key: string, ...rest: unknown[]): Promise<unknown>;
	zrem(key: string, ...members: string[]): Promise<unknown>;
	zrange(key: string, start: number, stop: number, ...rest: unknown[]): Promise<string[]>;
	connect?(): Promise<void>;
}

const R = 'og:report:';
const RZ = 'og:reports';
const V = 'og:visit:';

async function resolve(client: RedisLike | string): Promise<RedisLike> {
	if (typeof client !== 'string') return client;
	// a URL: import node-redis if present, else ioredis. Indirect specifiers so the type checker does
	// not require these optional peers to be installed (they resolve at runtime only).
	const nodeRedis = 'redis';
	const ioRedis = 'ioredis';
	try {
		const { createClient } = (await import(nodeRedis)) as { createClient: (o: { url: string }) => RedisLike };
		const c = createClient({ url: client });
		await c.connect?.();
		return c;
	} catch {
		/* try ioredis */
	}
	const mod = (await import(ioRedis)) as unknown as { default: new (url: string) => RedisLike };
	return new mod.default(client);
}

export function redisStore(client: RedisLike | string, opts: { ttlSeconds?: number; prefix?: string } = {}): ProfilerStore {
	const ttl = opts.ttlSeconds;
	let c: RedisLike | null = null;
	const need = async (): Promise<RedisLike> => (c ??= await resolve(client));
	// node-redis `zRange`/`zAdd` are camelCase; ioredis is lowercase. Duck-type at call sites via `any`.
	const setStr = async (r: RedisLike, key: string, val: string) => {
		if (ttl) await r.set(key, val, { EX: ttl } as unknown as string).catch(() => r.set(key, val, 'EX', ttl));
		else await r.set(key, val);
	};
	const zadd = (r: RedisLike, key: string, score: number, member: string) =>
		(r as unknown as { zAdd?: (k: string, m: { score: number; value: string }) => Promise<unknown> }).zAdd
			? (r as unknown as { zAdd: (k: string, m: { score: number; value: string }) => Promise<unknown> }).zAdd(key, { score, value: member })
			: r.zadd(key, score, member);
	const zrangeRev = async (r: RedisLike, key: string, n: number): Promise<string[]> => {
		const rev = r as unknown as { zRange?: (k: string, a: number, b: number, o?: unknown) => Promise<string[]> };
		if (rev.zRange) return rev.zRange(key, 0, n - 1, { REV: true });
		return r.zrange(key, 0, n - 1, 'REV');
	};
	return {
		kind: 'redis',
		async init() {
			await need();
		},
		async putReport(rec: ProfilerRecord) {
			const r = await need();
			const summary: ProfilerSummary = { id: rec.id, created: rec.created, page: rec.page, trigger: rec.trigger, label: rec.label, median: rec.median };
			await setStr(r, R + rec.id, JSON.stringify({ summary, dump: rec.dump }));
			await zadd(r, RZ, rec.created, rec.id);
		},
		async getReport(id: string): Promise<string | null> {
			const raw = await (await need()).get(R + id);
			if (!raw) return null;
			try {
				return (JSON.parse(raw) as { dump: string }).dump;
			} catch {
				return null;
			}
		},
		async listReports(limit = 30): Promise<ProfilerSummary[]> {
			const r = await need();
			const ids = await zrangeRev(r, RZ, limit);
			const out: ProfilerSummary[] = [];
			for (const id of ids) {
				const raw = await r.get(R + id);
				if (!raw) continue;
				try {
					out.push((JSON.parse(raw) as { summary: ProfilerSummary }).summary);
				} catch {
					/* skip */
				}
			}
			return out;
		},
		async deleteReport(id: string) {
			const r = await need();
			await r.del(R + id);
			await r.zrem(RZ, id);
		},
		async prune(keep: number) {
			const r = await need();
			// members beyond the newest `keep` — zRange ascending 0..-(keep+1)
			const asc = r as unknown as { zRange?: (k: string, a: number, b: number) => Promise<string[]> };
			const stale = asc.zRange ? await asc.zRange(RZ, 0, -(keep + 1)) : await r.zrange(RZ, 0, -(keep + 1));
			for (const id of stale) {
				await r.del(R + id);
				await r.zrem(RZ, id);
			}
		},
		async putVisit(rec: ProfilerVisitRecord) {
			const r = await need();
			await setStr(r, V + rec.key, JSON.stringify(rec));
			await zadd(r, `${V}z:${rec.page}`, rec.at, rec.key);
		},
		async listVisits(page: string, limit = 10): Promise<ProfilerVisitRecord[]> {
			const r = await need();
			const keys = await zrangeRev(r, `${V}z:${page}`, limit);
			const out: ProfilerVisitRecord[] = [];
			for (const k of keys) {
				const raw = await r.get(V + k);
				if (raw)
					try {
						out.push(JSON.parse(raw) as ProfilerVisitRecord);
					} catch {
						/* skip */
					}
			}
			return out;
		},
		async close() {
			await (c as unknown as { quit?: () => Promise<void>; disconnect?: () => void })?.quit?.().catch(() => {});
			c = null;
		}
	};
}
