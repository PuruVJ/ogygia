/**
 * THE SINK — how an ephemeral host keeps a picture of the whole site. A serverless instance lives
 * for seconds; nothing it measures survives it. With `sink: { url }` each instance posts what it
 * saw (one small row per request, one summary per sampler window, a caught request's dump) as
 * NDJSON to a URL the app owns — an endpoint, a bucket — and the site view reads those rows back in
 * the browser. Pure here: the rows, the buffer, and the aggregations the site view draws (the
 * request cloud, the layer cake per route, the hot functions of a brushed selection).
 */

export type SinkRow =
	| { k: 'req'; t: number; path: string; route: string | null; ms: number; cpu: number; wait: number; status: number; og?: number }
	| { k: 'win'; t0: number; t1: number; fns: { name: string; file: string; self_ms: number; category: string }[]; reqs?: number }
	| { k: 'trap'; t: number; path: string; ms: number; id: string; dump?: unknown };

export class SinkBuffer {
	#rows: SinkRow[] = [];
	#bytes = 0;
	constructor(readonly max_bytes = 512 * 1024) {}
	push(row: SinkRow): void {
		const line = JSON.stringify(row);
		// a full buffer drops the OLDEST request rows first, never a window or a catch
		while (this.#bytes + line.length > this.max_bytes && this.#rows.length) {
			const i = this.#rows.findIndex((r) => r.k === 'req');
			const [gone] = this.#rows.splice(i === -1 ? 0 : i, 1);
			this.#bytes -= JSON.stringify(gone).length + 1;
		}
		this.#rows.push(row);
		this.#bytes += line.length + 1;
	}
	get size(): number {
		return this.#rows.length;
	}
	/** everything buffered as NDJSON, and the buffer emptied */
	drain(): string {
		const out = this.#rows.map((r) => JSON.stringify(r)).join('\n');
		this.#rows = [];
		this.#bytes = 0;
		return out;
	}
}

/** NDJSON (one or many posts concatenated) → rows; a bad line is skipped. */
export function parse_sink(text: string): SinkRow[] {
	const out: SinkRow[] = [];
	for (const line of text.split('\n')) {
		const s = line.trim();
		if (!s) continue;
		try {
			const r = JSON.parse(s) as SinkRow;
			if (r && (r.k === 'req' || r.k === 'win' || r.k === 'trap')) out.push(r);
		} catch {
			/* skip */
		}
	}
	return out;
}

export interface CloudPoint {
	t: number;
	ms: number;
	route: string;
	path: string;
	status: number;
	cpu: number;
	wait: number;
}

export function cloud_points(rows: SinkRow[]): CloudPoint[] {
	const out: CloudPoint[] = [];
	for (const r of rows) if (r.k === 'req') out.push({ t: r.t, ms: r.ms, route: r.route ?? r.path, path: r.path, status: r.status, cpu: r.cpu, wait: r.wait });
	return out.sort((a, b) => a.t - b.t);
}

export interface CakeRow {
	route: string;
	n: number;
	/** ms summed over the route's requests */
	cpu: number;
	wait: number;
	rest: number;
	total: number;
	p50: number;
	p95: number;
}

/** Where the site's time goes, per route: CPU, waiting on calls, and the rest (the event loop,
 *  other requests in flight, the platform), summed and sorted by total. */
export function layer_cake(rows: SinkRow[]): CakeRow[] {
	const by = new Map<string, { ms: number[]; cpu: number; wait: number }>();
	for (const r of rows) {
		if (r.k !== 'req') continue;
		const key = r.route ?? r.path;
		let e = by.get(key);
		if (!e) by.set(key, (e = { ms: [], cpu: 0, wait: 0 }));
		e.ms.push(r.ms);
		e.cpu += r.cpu;
		e.wait += Math.min(r.wait, r.ms);
	}
	const pct = (xs: number[], p: number) => {
		const s = [...xs].sort((a, b) => a - b);
		return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
	};
	return [...by.entries()]
		.map(([route, e]) => {
			const total = e.ms.reduce((a, b) => a + b, 0);
			const cpu = Math.min(e.cpu, total);
			const wait = Math.min(e.wait, total - cpu);
			return { route, n: e.ms.length, cpu: r1(cpu), wait: r1(wait), rest: r1(total - cpu - wait), total: r1(total), p50: r1(pct(e.ms, 0.5)), p95: r1(pct(e.ms, 0.95)) };
		})
		.sort((a, b) => b.total - a.total);
}
const r1 = (n: number) => Math.round(n * 10) / 10;

/** The hot functions of the sampler windows that overlap [t0, t1] (a brushed selection of the
 *  cloud), merged by name + file and weighted by how much of each window is inside the range. */
export function hot_for_range(rows: SinkRow[], t0: number, t1: number, limit = 40): { name: string; file: string; category: string; self_ms: number; windows: number }[] {
	const by = new Map<string, { name: string; file: string; category: string; self_ms: number; windows: number }>();
	for (const r of rows) {
		if (r.k !== 'win' || r.t1 < t0 || r.t0 > t1) continue;
		const span = Math.max(r.t1 - r.t0, 1);
		const inside = Math.min(r.t1, t1) - Math.max(r.t0, t0);
		const w = Math.max(0, Math.min(1, inside / span));
		if (!w) continue;
		for (const f of r.fns) {
			const k = `${f.name}|${f.file}`;
			const e = by.get(k);
			if (e) {
				e.self_ms += f.self_ms * w;
				e.windows++;
			} else by.set(k, { name: f.name, file: f.file, category: f.category, self_ms: f.self_ms * w, windows: 1 });
		}
	}
	return [...by.values()]
		.map((f) => ({ ...f, self_ms: r1(f.self_ms) }))
		.sort((a, b) => b.self_ms - a.self_ms)
		.slice(0, limit);
}
