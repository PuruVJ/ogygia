/**
 * SINCE YOUR LAST LOAD — the dev loop's question: I changed the code and reloaded; what changed?
 * The Page tab keeps a small picture of each page's load (its findings, each island's timings, the
 * vitals and their parts) in session storage as the page goes away, and the next load of the same
 * page is read against it: findings fixed and new, islands that got faster or slower, vitals that
 * moved and the part of each that moved most. Pure (the storage lives in page.ts); a change must
 * clear the noise floor to count. The vitals use the profiler's own rule (page-insights
 * `vitals_moved`): "since your last load" and "since your last profile" never disagree.
 */
import { vitals_moved, type PartedVital, type VitalPart } from './page-insights.js';

export interface LoadSnapshot {
	path: string;
	/** epoch ms the picture was taken */
	at: number;
	findings: { code: string; names: string[] }[];
	islands: { name: string; load_ms: number; hydrate_ms: number }[];
	vitals: { key: string; value: number }[];
	/** each split vital's parts (page-insights `vital_parts`); older pictures have none */
	parts?: Partial<Record<PartedVital, VitalPart[]>>;
}

export interface SinceLoad {
	ago_ms: number;
	fixed: string[];
	added: string[];
	moved: { what: string; a: number; b: number; unit: 'ms' | ''; better: boolean; part?: { label: string; a: number; b: number } }[];
}

/** an island's step moved when it changed by at least this much (and 30%): a module load is noisier
 *  (the network, the dev server compiling), so it needs more */
const ISLAND_FLOOR_MS = { hydrate: 10, load: 50 } as const;

const label = (f: { code: string; names: string[] }) => (f.names.length ? `${f.code} (${[...new Set(f.names)].slice(0, 3).join(', ')})` : f.code);

export function since_load(prev: LoadSnapshot, now: LoadSnapshot, at = Date.now()): SinceLoad | null {
	if (prev.path !== now.path) return null;
	const key = (f: { code: string; names: string[] }) => `${f.code}|${[...new Set(f.names)].sort().join(',')}`;
	const had = new Set(prev.findings.map(key));
	const has = new Set(now.findings.map(key));
	const fixed = prev.findings.filter((f) => !has.has(key(f))).map(label);
	const added = now.findings.filter((f) => !had.has(key(f))).map(label);
	const moved: SinceLoad['moved'] = [];
	const table = (s: LoadSnapshot) => Object.fromEntries(s.vitals.map((v) => [v.key, v.value]));
	for (const m of vitals_moved(table(prev), table(now), (side, k) => (side === 'a' ? prev : now).parts?.[k] ?? null))
		moved.push({ what: m.key.toUpperCase(), a: m.a, b: m.b, unit: m.key === 'cls' ? '' : 'ms', better: m.b < m.a, ...(m.part ? { part: m.part } : {}) });
	for (const i of now.islands) {
		const p = prev.islands.find((x) => x.name === i.name);
		if (!p) continue;
		// (its hydrate step, and its module load: a change that made the island's file heavier or lighter)
		for (const step of ['hydrate', 'load'] as const) {
			const was = step === 'hydrate' ? p.hydrate_ms : p.load_ms;
			const is = step === 'hydrate' ? i.hydrate_ms : i.load_ms;
			const d = is - was;
			if (Math.abs(d) >= ISLAND_FLOOR_MS[step] && Math.abs(d) >= Math.max(was, is) * 0.3) moved.push({ what: `${i.name} ${step}`, a: was, b: is, unit: 'ms', better: d < 0 });
		}
	}
	// the biggest moves first
	moved.sort((x, y) => Math.abs(y.b - y.a) / (Math.abs(y.a) || 1) - Math.abs(x.b - x.a) / (Math.abs(x.a) || 1));
	return { ago_ms: Math.max(0, at - prev.at), fixed, added, moved: moved.slice(0, 8) };
}
