/**
 * SQLite report store — a file (or `:memory:`). The simplest durable backend: one file, no server,
 * survives a restart. Uses Node's built-in `node:sqlite` (Node 22.5+) when present, else
 * `better-sqlite3` if installed. Both are synchronous, which is fine here: a put is one small
 * insert, a get one indexed lookup, off the request's hot path (a report is written once, after
 * the recording).
 *
 *   import { sqliteStore } from 'ogygia/profiler/storage';
 *   ogygia.profiler({ store: sqliteStore('.ogygia/profiles.db') });
 */
import { createRequire } from 'node:module';
import type { ProfilerStore, ProfilerRecord, ProfilerSummary, ProfilerVisitRecord } from './index.js';

const require = createRequire(import.meta.url);

interface SyncDb {
	exec(sql: string): void;
	prepare(sql: string): SyncStmt;
	close(): void;
}
interface SyncStmt {
	run(...args: unknown[]): unknown;
	get(...args: unknown[]): unknown;
	all(...args: unknown[]): unknown[];
}

/** Open a synchronous sqlite database from whichever driver is installed. */
function open(filename: string): SyncDb {
	// make the parent directory (a plain path like `.ogygia/profiles.db` needs `.ogygia` to exist)
	if (filename !== ':memory:' && !filename.startsWith('file::memory:')) {
		try {
			const fs = require('node:fs') as typeof import('node:fs');
			const path = require('node:path') as typeof import('node:path');
			const dir = path.dirname(filename);
			if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
		} catch {
			/* best effort — the open below will report a real problem */
		}
	}
	// node:sqlite (built in) — `new DatabaseSync(path)`, `.exec`, `.prepare().run/get/all`
	try {
		const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => SyncDb };
		return new DatabaseSync(filename);
	} catch {
		/* fall through */
	}
	try {
		const Database = require('better-sqlite3') as new (p: string) => SyncDb;
		return new Database(filename);
	} catch {
		throw new Error("ogygia/profiler: sqliteStore needs Node 22.5+ (built-in node:sqlite) or the 'better-sqlite3' package.");
	}
}

export function sqliteStore(filename = '.ogygia/profiles.db'): ProfilerStore {
	let db: SyncDb | null = null;
	const need = (): SyncDb => {
		if (db) return db;
		db = open(filename);
		db.exec(`
			CREATE TABLE IF NOT EXISTS reports (
				id TEXT PRIMARY KEY, created INTEGER NOT NULL, page TEXT, trigger TEXT,
				label TEXT, median REAL, dump TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS reports_created ON reports (created);
			CREATE TABLE IF NOT EXISTS visits (
				key TEXT PRIMARY KEY, page TEXT NOT NULL, at INTEGER NOT NULL, visit TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS visits_page ON visits (page, at);
		`);
		return db;
	};
	return {
		kind: 'sqlite',
		init() {
			need();
		},
		putReport(rec: ProfilerRecord) {
			need()
				.prepare('INSERT INTO reports (id,created,page,trigger,label,median,dump) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET created=excluded.created,page=excluded.page,trigger=excluded.trigger,label=excluded.label,median=excluded.median,dump=excluded.dump')
				.run(rec.id, rec.created, rec.page, rec.trigger, rec.label, rec.median, rec.dump);
		},
		getReport(id: string): string | null {
			const row = need().prepare('SELECT dump FROM reports WHERE id = ?').get(id) as { dump: string } | undefined;
			return row?.dump ?? null;
		},
		listReports(limit = 30): ProfilerSummary[] {
			return need().prepare('SELECT id,created,page,trigger,label,median FROM reports ORDER BY created DESC LIMIT ?').all(limit) as ProfilerSummary[];
		},
		deleteReport(id: string) {
			need().prepare('DELETE FROM reports WHERE id = ?').run(id);
		},
		prune(keep: number) {
			need()
				.prepare('DELETE FROM reports WHERE id NOT IN (SELECT id FROM reports ORDER BY created DESC LIMIT ?)')
				.run(keep);
		},
		putVisit(rec: ProfilerVisitRecord) {
			need()
				.prepare('INSERT INTO visits (key,page,at,visit) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at,visit=excluded.visit')
				.run(rec.key, rec.page, rec.at, rec.visit);
		},
		listVisits(page: string, limit = 10): ProfilerVisitRecord[] {
			return need().prepare('SELECT key,page,at,visit FROM visits WHERE page = ? ORDER BY at DESC LIMIT ?').all(page, limit) as ProfilerVisitRecord[];
		},
		close() {
			db?.close();
			db = null;
		}
	};
}
