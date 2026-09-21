/**
 * THE BROWSER STORE — the profiler's memory on an ephemeral host. Reports (their dumps) and the
 * beacon's visits live in this browser's IndexedDB, on the app's origin: a report page that the
 * server no longer has renders from here; the compare page and the history line work across
 * instances; the one-clock timeline joins a report to the visit this same browser made. The
 * runtime's beacon writes visits into the same database (runtime/beacon.ts — one schema, two
 * writers). Everything is best-effort: no IndexedDB, a private window, a full quota → empty.
 */
const DB_NAME = 'ogygia-profiler';
const DB_VERSION = 1;
const MAX_REPORTS = 40;

export interface StoredDump {
	id: string;
	page: string | null;
	at: number;
	label: string;
	trigger: string;
	/** the report's median render, ms (page mode) */
	median: number | null;
	/** the raw dump (`{ kind: 'ogygia-profiler-dump', meta, analysis, extras }`) */
	dump: unknown;
}

export interface StoredVisit {
	key: string;
	page: string;
	at: number;
	visit: unknown;
	snapshots: { fp: string; ssr: string; hydrated: string; final?: string }[];
}

function open_db(): Promise<IDBDatabase | null> {
	return new Promise((resolve) => {
		try {
			if (typeof indexedDB === 'undefined') return resolve(null);
			const req = indexedDB.open(DB_NAME, DB_VERSION);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains('reports')) db.createObjectStore('reports', { keyPath: 'id' });
				if (!db.objectStoreNames.contains('visits')) db.createObjectStore('visits', { keyPath: 'key' });
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
			req.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

function done<T>(req: IDBRequest<T>): Promise<T | null> {
	return new Promise((resolve) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => resolve(null);
	});
}

async function with_store<T>(name: 'reports' | 'visits', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T>): Promise<T | null> {
	const db = await open_db();
	if (!db) return null;
	try {
		const tx = db.transaction(name, mode);
		const out = await fn(tx.objectStore(name));
		db.close();
		return out;
	} catch {
		return null;
	}
}

/** Keep a report's dump. The newest MAX_REPORTS stay. */
export async function put_report(dump: { meta: { id: string; page?: string; created: number; trigger: string; runs?: number[]; request?: { path: string } } }): Promise<boolean> {
	const m = dump.meta;
	const median = m.runs?.length ? [...m.runs].sort((a, b) => a - b)[Math.floor(m.runs.length / 2)] : null;
	const rec: StoredDump = { id: m.id, page: m.page ?? m.request?.path ?? null, at: m.created, label: m.page ?? m.request?.path ?? m.trigger, trigger: m.trigger, median, dump };
	const ok = await with_store('reports', 'readwrite', async (s) => {
		s.put(rec);
		const keys = ((await done(s.getAll())) as StoredDump[] | null) ?? [];
		for (const old of keys.sort((a, b) => b.at - a.at).slice(MAX_REPORTS)) s.delete(old.id);
		return true;
	});
	return ok === true;
}

export async function get_report(id: string): Promise<StoredDump | null> {
	return ((await with_store('reports', 'readonly', (s) => done(s.get(id)))) as StoredDump | null | undefined) ?? null;
}

/** Every kept report, newest first, without the dumps (the list is cheap to draw). */
export async function list_reports(): Promise<Omit<StoredDump, 'dump'>[]> {
	const all = ((await with_store('reports', 'readonly', (s) => done(s.getAll()))) as StoredDump[] | null) ?? [];
	return all.sort((a, b) => b.at - a.at).map(({ dump: _d, ...rest }) => rest);
}

export async function delete_report(id: string): Promise<void> {
	await with_store('reports', 'readwrite', async (s) => {
		s.delete(id);
		return true;
	});
}

/** The visits of a page this browser made, newest first. */
export async function list_visits(page: string, limit = 10): Promise<StoredVisit[]> {
	const all = ((await with_store('visits', 'readonly', (s) => done(s.getAll()))) as StoredVisit[] | null) ?? [];
	return all
		.filter((v) => v.page === page)
		.sort((a, b) => b.at - a.at)
		.slice(0, limit);
}

export async function latest_visit(page: string): Promise<StoredVisit | null> {
	return (await list_visits(page, 1))[0] ?? null;
}

export async function clear_all(): Promise<void> {
	await with_store('reports', 'readwrite', async (s) => (s.clear(), true));
	await with_store('visits', 'readwrite', async (s) => (s.clear(), true));
}
