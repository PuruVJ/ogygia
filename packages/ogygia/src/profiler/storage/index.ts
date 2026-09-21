/**
 * PROFILER STORAGE — where finished reports live. By default the profiler keeps them in the
 * instance's memory (and the browser keeps its own copies), which is all a single long-lived
 * server needs. But on an ephemeral host (Amplify, Vercel, Netlify) the instance that recorded a
 * report is often gone before the report page is opened, and a team wants every teammate's
 * recordings in one place. A `ProfilerStore` is the seam for that: point the profiler at one and
 * every report is written there and read back from there, across instances and across a restart.
 *
 * The contract is deliberately tiny — put, get, list, delete a report, and (optionally) the same
 * for the browser visits a page collected — so a backend is a few dozen lines. Adapters ship for
 * SQLite (a file, or `:memory:`), Redis and Postgres; a custom one is any object of this shape.
 *
 *   import { sqliteStore } from 'ogygia/profiler/storage';
 *   ogygia.profiler({ store: sqliteStore('.ogygia/profiles.db') });
 *
 * A report is stored as its portable dump (the same JSON the `.ogp` export and the agent view are
 * built from): `meta` + `analysis` + `extras`, plus a few summary columns for the list. Nothing
 * here is encrypted — a store is trusted infrastructure the profiler owner runs; share links stay
 * the encrypted path for anything that leaves it.
 */

/** One report as a store holds it: summary columns for the list, and the portable dump as JSON. */
export interface ProfilerRecord {
	id: string;
	/** epoch ms the report was created */
	created: number;
	/** the profiled page (page mode), else null */
	page: string | null;
	/** `window` | `page` | `request` | `trap` */
	trigger: string;
	/** a human label for the list (the page, or the request path) */
	label: string;
	/** the median render in ms (page mode), else null — shown in the list */
	median: number | null;
	/** the portable dump as a JSON string: `{ kind, version, meta, analysis, extras }` */
	dump: string;
}

/** What the list needs — every column of a record except the (large) dump. */
export type ProfilerSummary = Omit<ProfilerRecord, 'dump'>;

/** One browser visit a page collected (the beacon), as a store holds it. Optional to support. */
export interface ProfilerVisitRecord {
	/** `${page}\0${epoch_ms}` — unique per visit */
	key: string;
	page: string;
	/** epoch ms */
	at: number;
	/** the visit payload as a JSON string */
	visit: string;
}

/**
 * The storage contract. Report methods are required; visit methods are optional (a store that omits
 * them keeps visits in memory as before). All async so a network backend fits; a memory or SQLite
 * store just resolves immediately.
 */
export interface ProfilerStore {
	/** Called once before first use — create tables, connect, etc. Optional. */
	init?(): Promise<void> | void;
	/** Write (or overwrite) a report. */
	putReport(rec: ProfilerRecord): Promise<void> | void;
	/** Read a report's full dump JSON, or null when absent. */
	getReport(id: string): Promise<string | null> | string | null;
	/** The most recent reports (summaries), newest first. */
	listReports(limit?: number): Promise<ProfilerSummary[]> | ProfilerSummary[];
	/** Remove a report. */
	deleteReport(id: string): Promise<void> | void;
	/** Keep at most `keep` reports, dropping the oldest — the store's own LRU, called after a put. */
	prune?(keep: number): Promise<void> | void;

	putVisit?(rec: ProfilerVisitRecord): Promise<void> | void;
	listVisits?(page: string, limit?: number): Promise<ProfilerVisitRecord[]> | ProfilerVisitRecord[];

	/** Release connections. Optional. */
	close?(): Promise<void> | void;
	/** A name for the dashboard ("sqlite", "redis", "postgres", "memory"). */
	readonly kind: string;
}

// ── the default: in memory ─────────────────────────────────────────────────────────────────────

/** The default store — a Map with an LRU cap. Exactly what the profiler did before stores existed;
 *  made explicit so the host has one code path. Nothing survives a restart. */
export function memoryStore(cap = 50): ProfilerStore {
	const reports = new Map<string, ProfilerRecord>();
	const visits: ProfilerVisitRecord[] = [];
	return {
		kind: 'memory',
		putReport(rec) {
			reports.delete(rec.id); // move to newest
			reports.set(rec.id, rec);
			while (reports.size > cap) {
				const oldest = reports.keys().next().value;
				if (oldest === undefined) break;
				reports.delete(oldest);
			}
		},
		getReport(id) {
			return reports.get(id)?.dump ?? null;
		},
		listReports(limit = 30) {
			return [...reports.values()]
				.sort((a, b) => b.created - a.created)
				.slice(0, limit)
				.map(({ dump: _dump, ...s }) => s);
		},
		deleteReport(id) {
			reports.delete(id);
		},
		prune(keep) {
			while (reports.size > keep) {
				const oldest = reports.keys().next().value;
				if (oldest === undefined) break;
				reports.delete(oldest);
			}
		},
		putVisit(rec) {
			visits.push(rec);
			if (visits.length > 2000) visits.shift();
		},
		listVisits(page, limit = 10) {
			return visits
				.filter((v) => v.page === page)
				.sort((a, b) => b.at - a.at)
				.slice(0, limit);
		}
	};
}

// ── shared summary helper (used by every SQL-ish adapter) ───────────────────────────────────────

/** Pull the summary columns off a record for storing them alongside the dump. */
export function recordColumns(rec: ProfilerRecord): ProfilerSummary {
	return { id: rec.id, created: rec.created, page: rec.page, trigger: rec.trigger, label: rec.label, median: rec.median };
}

// ── the runtime seam ────────────────────────────────────────────────────────────────────────────

/**
 * Give the profiler its store AT RUNTIME. The profiler is configured in `vite.config.ts` (build
 * time, serializable), but a store is a live object with a DB connection — so it is set here
 * instead, once, before the first request:
 *
 *   // src/hooks.server.ts
 *   import { setProfilerStore } from 'ogygia/profiler/storage';
 *   import { postgresStore } from 'ogygia/profiler/storage/postgres';
 *   setProfilerStore(postgresStore(process.env.DATABASE_URL!));
 *
 * The profiler reads this when it mounts and every finished report is written there. Call it before
 * the profiler handles its first request; a later call is ignored (the instance already mounted).
 */
const STORE_SLOT = Symbol.for('ogygia.profiler.store.v1');
export function setProfilerStore(store: ProfilerStore): void {
	(globalThis as unknown as Record<symbol, ProfilerStore>)[STORE_SLOT] = store;
}
/** The store set by {@link setProfilerStore}, if any — read by the profiler host on mount. */
export function getProfilerStore(): ProfilerStore | undefined {
	return (globalThis as unknown as Record<symbol, ProfilerStore | undefined>)[STORE_SLOT];
}
