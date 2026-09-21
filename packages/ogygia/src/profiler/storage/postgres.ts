/**
 * Postgres report store — the durable, team-shared backend. Reports go in one `ogygia_reports`
 * table (a `jsonb` dump plus summary columns), visits in `ogygia_visits`. Pass a connection string
 * (the `pg` package is imported on demand) or an already-made `pg` Pool.
 *
 *   import { postgresStore } from 'ogygia/profiler/storage';
 *   ogygia.profiler({ store: postgresStore(process.env.DATABASE_URL) });
 *   // or reuse your pool:
 *   ogygia.profiler({ store: postgresStore(myPool) });
 *
 * `schema` puts the tables in a named schema; `table` overrides the base name. The dump is stored
 * as `jsonb`, so a hosted dashboard can query inside it (`dump->'meta'->>'page'`) without shipping
 * the whole blob.
 */
import type { ProfilerStore, ProfilerRecord, ProfilerSummary, ProfilerVisitRecord } from './index.js';

interface PgLike {
	query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
	end?(): Promise<void>;
}

async function resolve(client: PgLike | string): Promise<PgLike> {
	if (typeof client !== 'string') return client;
	// indirect specifier so the type checker does not require `pg` to be installed (runtime peer)
	const pgName = 'pg';
	const pg = (await import(pgName)) as unknown as { default?: { Pool: new (o: { connectionString: string }) => PgLike }; Pool?: new (o: { connectionString: string }) => PgLike };
	const Pool = pg.Pool ?? pg.default?.Pool;
	if (!Pool) throw new Error("ogygia/profiler: postgresStore needs the 'pg' package.");
	return new Pool({ connectionString: client });
}

export function postgresStore(client: PgLike | string, opts: { schema?: string; table?: string } = {}): ProfilerStore {
	const base = opts.table ?? 'ogygia';
	const q = (n: string) => (opts.schema ? `"${opts.schema}"."${base}_${n}"` : `"${base}_${n}"`);
	const R = q('reports');
	const V = q('visits');
	let c: PgLike | null = null;
	let ready: Promise<void> | null = null;
	const need = async (): Promise<PgLike> => {
		c ??= await resolve(client);
		ready ??= (async () => {
			if (opts.schema) await c!.query(`CREATE SCHEMA IF NOT EXISTS "${opts.schema}"`);
			await c!.query(`CREATE TABLE IF NOT EXISTS ${R} (id TEXT PRIMARY KEY, created BIGINT NOT NULL, page TEXT, trigger TEXT, label TEXT, median DOUBLE PRECISION, dump JSONB NOT NULL)`);
			await c!.query(`CREATE INDEX IF NOT EXISTS ${base}_reports_created ON ${R} (created DESC)`);
			await c!.query(`CREATE TABLE IF NOT EXISTS ${V} (key TEXT PRIMARY KEY, page TEXT NOT NULL, at BIGINT NOT NULL, visit JSONB NOT NULL)`);
			await c!.query(`CREATE INDEX IF NOT EXISTS ${base}_visits_page ON ${V} (page, at DESC)`);
		})();
		await ready;
		return c!;
	};
	return {
		kind: 'postgres',
		async init() {
			await need();
		},
		async putReport(rec: ProfilerRecord) {
			const db = await need();
			await db.query(
				`INSERT INTO ${R} (id,created,page,trigger,label,median,dump) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
				 ON CONFLICT (id) DO UPDATE SET created=EXCLUDED.created,page=EXCLUDED.page,trigger=EXCLUDED.trigger,label=EXCLUDED.label,median=EXCLUDED.median,dump=EXCLUDED.dump`,
				[rec.id, rec.created, rec.page, rec.trigger, rec.label, rec.median, rec.dump]
			);
		},
		async getReport(id: string): Promise<string | null> {
			const { rows } = await (await need()).query(`SELECT dump FROM ${R} WHERE id = $1`, [id]);
			if (!rows.length) return null;
			const d = rows[0].dump;
			return typeof d === 'string' ? d : JSON.stringify(d);
		},
		async listReports(limit = 30): Promise<ProfilerSummary[]> {
			const { rows } = await (await need()).query(`SELECT id,created,page,trigger,label,median FROM ${R} ORDER BY created DESC LIMIT $1`, [limit]);
			return rows.map((r) => ({ id: r.id as string, created: Number(r.created), page: (r.page as string) ?? null, trigger: r.trigger as string, label: r.label as string, median: r.median === null ? null : Number(r.median) }));
		},
		async deleteReport(id: string) {
			await (await need()).query(`DELETE FROM ${R} WHERE id = $1`, [id]);
		},
		async prune(keep: number) {
			await (await need()).query(`DELETE FROM ${R} WHERE id NOT IN (SELECT id FROM ${R} ORDER BY created DESC LIMIT $1)`, [keep]);
		},
		async putVisit(rec: ProfilerVisitRecord) {
			await (await need()).query(`INSERT INTO ${V} (key,page,at,visit) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (key) DO UPDATE SET at=EXCLUDED.at,visit=EXCLUDED.visit`, [rec.key, rec.page, rec.at, rec.visit]);
		},
		async listVisits(page: string, limit = 10): Promise<ProfilerVisitRecord[]> {
			const { rows } = await (await need()).query(`SELECT key,page,at,visit FROM ${V} WHERE page = $1 ORDER BY at DESC LIMIT $2`, [page, limit]);
			return rows.map((r) => ({ key: r.key as string, page: r.page as string, at: Number(r.at), visit: typeof r.visit === 'string' ? (r.visit as string) : JSON.stringify(r.visit) }));
		},
		async close() {
			await c?.end?.();
			c = null;
		}
	};
}
