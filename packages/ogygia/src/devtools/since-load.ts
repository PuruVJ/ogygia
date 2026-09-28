/**
 * SINCE YOUR LAST LOAD — the dev loop's question: I changed the code and reloaded; what changed?
 * The Page tab keeps a small picture of each page's load (its findings, each island's timings, the
 * vitals) in session storage as the page goes away, and the next load of the same page is read
 * against it: findings fixed and new, islands that got faster or slower, vitals that moved. Pure
 * (the storage lives in page.ts); a change must clear the noise floor to count.
 */

export interface LoadSnapshot {
	path: string;
	/** epoch ms the picture was taken */
	at: number;
	findings: { code: string; names: string[] }[];
	islands: { name: string; load_ms: number; hydrate_ms: number }[];
	vitals: { key: string; value: number }[];
}

export interface SinceLoad {
	ago_ms: number;
	fixed: string[];
	added: string[];
	moved: { what: string; a: number; b: number; unit: 'ms' | '' ; better: boolean }[];
}

/** a vital moved when it changed by at least this much (and 20%) */
const VITAL_FLOOR: Record<string, number> = { lcp: 100, fcp: 100, ttfb: 50, inp: 40, cls: 0.02 };
/** an island's hydrate step moved when it changed by at least this much (and 30%) */
const ISLAND_FLOOR_MS = 10;

const label = (f: { code: string; names: string[] }) => (f.names.length ? `${f.code} (${[...new Set(f.names)].slice(0, 3).join(', ')})` : f.code);

export function since_load(prev: LoadSnapshot, now: LoadSnapshot, at = Date.now()): SinceLoad | null {
	if (prev.path !== now.path) return null;
	const key = (f: { code: string; names: string[] }) => `${f.code}|${[...new Set(f.names)].sort().join(',')}`;
	const had = new Set(prev.findings.map(key));
	const has = new Set(now.findings.map(key));
	const fixed = prev.findings.filter((f) => !has.has(key(f))).map(label);
	const added = now.findings.filter((f) => !had.has(key(f))).map(label);
	const moved: SinceLoad['moved'] = [];
	for (const v of now.vitals) {
		const p = prev.vitals.find((x) => x.key === v.key);
		const floor = VITAL_FLOOR[v.key];
		if (!p || floor === undefined) continue;
		const d = v.value - p.value;
		if (Math.abs(d) >= floor && Math.abs(d) >= Math.abs(p.value) * 0.2)
			moved.push({ what: v.key.toUpperCase(), a: p.value, b: v.value, unit: v.key === 'cls' ? '' : 'ms', better: d < 0 });
	}
	for (const i of now.islands) {
		const p = prev.islands.find((x) => x.name === i.name);
		if (!p) continue;
		const d = i.hydrate_ms - p.hydrate_ms;
		if (Math.abs(d) >= ISLAND_FLOOR_MS && Math.abs(d) >= Math.max(p.hydrate_ms, i.hydrate_ms) * 0.3)
			moved.push({ what: `${i.name} hydrate`, a: p.hydrate_ms, b: i.hydrate_ms, unit: 'ms', better: d < 0 });
	}
	// the biggest moves first
	moved.sort((x, y) => Math.abs(y.b - y.a) / (Math.abs(y.a) || 1) - Math.abs(x.b - x.a) / (Math.abs(x.a) || 1));
	return { ago_ms: Math.max(0, at - prev.at), fixed, added, moved: moved.slice(0, 8) };
}
