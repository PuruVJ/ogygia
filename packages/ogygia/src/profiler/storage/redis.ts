/**
 * Redis report store — for a fleet that already runs Redis, or a serverless deployment using a
 * hosted Redis (Upstash, ElastiCache). Reports are strings under `<prefix>report:<id>`, a sorted set
 * `<prefix>reports` (score = created ms) drives the list and the LRU prune, and visits mirror that.
 * The prefix defaults to `og:`.
 *
 *   import { redisStore } from 'ogygia/profiler/storage';
 *   // pass a connection string (node-redis / ioredis is imported on demand)…
 *   ogygia.profiler({ store: redisStore('redis://localhost:6379') });
 *   // …or an already-connected client (node-redis or ioredis both work)
 *   ogygia.profiler({ store: redisStore(myClient) });
 *
 * A TTL (seconds) expires reports on their own — handy on a shared instance where you only want the
 * last day of recordings. The index sets drop an expired report's id the next time they are read or
 * pruned, so they do not grow with every report that expired.
 */
import type { ProfilerStore, ProfilerRecord, ProfilerSummary, ProfilerVisitRecord } from './index.js';

/** The subset of a Redis client this store uses — node-redis and ioredis both satisfy it (their
 *  method names differ in case, and a few calls take options objects on one and arguments on the
 *  other; the flavour is read once, below). */
interface RedisLike {
	set(key: string, val: string, ...rest: unknown[]): Promise<unknown>;
	get(key: string): Promise<string | null>;
	del(key: string | string[]): Promise<unknown>;
	zadd?(key: string, ...rest: unknown[]): Promise<unknown>;
	zrem?(key: string, ...members: string[]): Promise<unknown>;
	zrange?(key: string, start: number, stop: number, ...rest: unknown[]): Promise<string[]>;
	zcard?(key: string): Promise<number>;
	connect?(): Promise<void>;
}

/** node-redis (v4+): camelCase methods, options objects */
interface NodeRedis {
	set(key: string, val: string, opts?: { EX: number }): Promise<unknown>;
	zAdd(key: string, m: { score: number; value: string }): Promise<unknown>;
	zRem(key: string, members: string | string[]): Promise<unknown>;
	zRange(key: string, a: number, b: number, o?: { REV: true }): Promise<string[]>;
	zCard(key: string): Promise<number>;
}

/** reports kept at most, whatever the host prunes to (a store used on its own still has a cap) */
const MAX_REPORTS = 1000;
/** browser visits kept per page (the profiler reads the latest ten) */
const MAX_VISITS_PER_PAGE = 20;

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
	const prefix = opts.prefix ?? 'og:';
	const R = `${prefix}report:`;
	const RZ = `${prefix}reports`;
	const V = `${prefix}visit:`;
	const VZ = (page: string) => `${V}z:${page}`;
	let c: RedisLike | null = null;
	const need = async (): Promise<RedisLike> => (c ??= await resolve(client));
	// THE FLAVOUR, read once from the client's own methods: node-redis has `zAdd`, ioredis `zadd`.
	// (Trying one form and falling back on the error cost ioredis a round trip on every write.)
	const node = (r: RedisLike): NodeRedis | null => (typeof (r as unknown as NodeRedis).zAdd === 'function' ? (r as unknown as NodeRedis) : null);
	const setStr = async (r: RedisLike, key: string, val: string) => {
		const n = node(r);
		if (!ttl) await r.set(key, val);
		else if (n) await n.set(key, val, { EX: ttl });
		else await r.set(key, val, 'EX', ttl);
	};
	const zadd = (r: RedisLike, key: string, score: number, member: string) => {
		const n = node(r);
		return n ? n.zAdd(key, { score, value: member }) : r.zadd!(key, score, member);
	};
	const zrem = (r: RedisLike, key: string, members: string[]) => {
		if (!members.length) return Promise.resolve();
		const n = node(r);
		return n ? n.zRem(key, members) : r.zrem!(key, ...members);
	};
	const zrange = (r: RedisLike, key: string, a: number, b: number, rev = false): Promise<string[]> => {
		const n = node(r);
		if (n) return rev ? n.zRange(key, a, b, { REV: true }) : n.zRange(key, a, b);
		return rev ? r.zrange!(key, a, b, 'REV') : r.zrange!(key, a, b);
	};
	const zcard = (r: RedisLike, key: string): Promise<number> => {
		const n = node(r);
		return n ? n.zCard(key) : r.zcard!(key);
	};
	/** drop every member but the newest `keep`, with the keys they name */
	const trim = async (r: RedisLike, key: string, item: string, keep: number) => {
		const stale = await zrange(r, key, 0, -(keep + 1));
		if (!stale.length) return;
		await r.del(stale.map((m) => item + m));
		await zrem(r, key, stale);
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
			// the store's own cap, whatever the host prunes to: one ZCARD, a trim only past it
			if ((await zcard(r, RZ)) > MAX_REPORTS) await trim(r, RZ, R, MAX_REPORTS);
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
			const ids = await zrange(r, RZ, 0, limit - 1, true);
			const out: ProfilerSummary[] = [];
			const gone: string[] = [];
			for (const id of ids) {
				const raw = await r.get(R + id);
				if (!raw) {
					gone.push(id); // expired (TTL) or deleted elsewhere: its id leaves the index too
					continue;
				}
				try {
					out.push((JSON.parse(raw) as { summary: ProfilerSummary }).summary);
				} catch {
					/* skip */
				}
			}
			await zrem(r, RZ, gone);
			return out;
		},
		async deleteReport(id: string) {
			const r = await need();
			await r.del(R + id);
			await zrem(r, RZ, [id]);
		},
		async prune(keep: number) {
			await trim(await need(), RZ, R, keep);
		},
		async putVisit(rec: ProfilerVisitRecord) {
			const r = await need();
			await setStr(r, V + rec.key, JSON.stringify(rec));
			await zadd(r, VZ(rec.page), rec.at, rec.key);
			if ((await zcard(r, VZ(rec.page))) > MAX_VISITS_PER_PAGE) await trim(r, VZ(rec.page), V, MAX_VISITS_PER_PAGE);
		},
		async listVisits(page: string, limit = 10): Promise<ProfilerVisitRecord[]> {
			const r = await need();
			const keys = await zrange(r, VZ(page), 0, limit - 1, true);
			const out: ProfilerVisitRecord[] = [];
			const gone: string[] = [];
			for (const k of keys) {
				const raw = await r.get(V + k);
				if (!raw) {
					gone.push(k);
					continue;
				}
				try {
					out.push(JSON.parse(raw) as ProfilerVisitRecord);
				} catch {
					/* skip */
				}
			}
			await zrem(r, VZ(page), gone);
			return out;
		},
		async close() {
			await (c as unknown as { quit?: () => Promise<void>; disconnect?: () => void })?.quit?.().catch(() => {});
			c = null;
		}
	};
}
