/**
 * MEASURE — a page list rendered under the profiler on a running server (a local preview, a
 * deployed one), folded into a small snapshot a CI step can keep and diff. Nothing new is
 * instrumented: this is the `/__profiler/page?format=json` report the UI reads, reduced to the
 * numbers a budget can be set on. Pure apart from the fetch it is handed, so a test drives it with
 * a fake and a runner with the real one.
 */

/** What one page costs, from the profiler's JSON report. */
export interface PageSnapshot {
	page: string;
	/** median render across the runs, ms */
	render_p50: number;
	/** every run, ms */
	runs: number[];
	busy_ms: number;
	wait_ms: number;
	/** the cold (first) render's extra over a warm one, ms */
	cold_extra_ms: number;
	seed_kb: number;
	props_kb: number;
	/** unique JS the page's islands load, KB (a built app) */
	islands_js_kb: number;
	islands: number;
	/** the biggest components by self time, per render */
	components: { name: string; self_ms: number; total_ms: number }[];
	/** the hottest functions by self time */
	functions: { name: string; file: string; self_ms: number }[];
	/** the paths to fix: owner and what the path costs */
	paths: { owner: string; ms: number; fns: number }[];
	/** finding codes at warn severity */
	warnings: string[];
	phases: Record<string, number>;
}

export interface PerfSnapshot {
	version: 1;
	at: number;
	node: string;
	/** free-form: the commit, the branch, the deploy URL */
	label?: string;
	pages: PageSnapshot[];
}

/** The subset of the profiler's JSON report this reads (kept loose: an older server answers less). */
export interface ReportLike {
	node?: string;
	target?: { runs?: number[] | null; page?: string | null };
	summary?: { busy_ms?: number };
	timeline?: { wait_ms?: number; phases?: { label?: string; phase?: string; cpu_ms?: number; wait_ms?: number }[] } | null;
	cold?: { ms?: number; files?: { extra_ms: number }[] } | null;
	ogygia?: { seed_bytes?: number; tail_bytes?: number; islands?: number; island_rows?: { js_bytes?: number | null; modules?: string[] }[] } | null;
	components?: { name: string; self_ms: number; total_ms: number }[];
	hot_functions?: { name: string; file: string; self_ms: number }[];
	paths?: { owner: { name: string }; ms: number; functions: unknown[] }[];
	findings?: { code: string; severity: string }[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

/** One report → one page's snapshot. */
export function snapshot_page(page: string, report: ReportLike): PageSnapshot {
	const runs = (report.target?.runs ?? []).filter((n): n is number => typeof n === 'number');
	const p50 = median(runs);
	const cold = report.cold?.ms ?? 0;
	const rows = report.ogygia?.island_rows ?? [];
	// unique modules across the islands: what a visitor downloads in all
	const seen = new Set<string>();
	let js = 0;
	for (const r of rows) {
		if (r.js_bytes == null) continue;
		const mods = r.modules ?? [];
		const fresh = mods.filter((m) => !seen.has(m));
		if (!mods.length) js += r.js_bytes;
		else js += (r.js_bytes * fresh.length) / mods.length;
		for (const m of mods) seen.add(m);
	}
	const phases: Record<string, number> = {};
	for (const ph of report.timeline?.phases ?? []) phases[ph.phase ?? ph.label ?? 'other'] = r1((ph.cpu_ms ?? 0) + (ph.wait_ms ?? 0));
	return {
		page,
		render_p50: r1(p50),
		runs: runs.map(r1),
		busy_ms: r1(report.summary?.busy_ms ?? 0),
		wait_ms: r1(report.timeline?.wait_ms ?? 0),
		cold_extra_ms: r1(cold && p50 ? Math.max(0, cold - p50) : 0),
		seed_kb: r1((report.ogygia?.seed_bytes ?? 0) / 1024),
		props_kb: r1((report.ogygia?.tail_bytes ?? 0) / 1024),
		islands_js_kb: r1(js / 1024),
		islands: report.ogygia?.islands ?? 0,
		components: (report.components ?? [])
			.slice()
			.sort((a, b) => b.self_ms - a.self_ms)
			.slice(0, 15)
			.map((c) => ({ name: c.name, self_ms: r1(c.self_ms), total_ms: r1(c.total_ms) })),
		functions: (report.hot_functions ?? []).slice(0, 15).map((f) => ({ name: f.name, file: f.file, self_ms: r1(f.self_ms) })),
		paths: (report.paths ?? []).slice(0, 5).map((p) => ({ owner: p.owner.name, ms: r1(p.ms), fns: p.functions.length })),
		warnings: (report.findings ?? []).filter((f) => f.severity === 'warn').map((f) => f.code),
		phases
	};
}

export interface MeasureOptions {
	/** the server's origin, `http://127.0.0.1:4173` or a deployed preview */
	url: string;
	pages: string[];
	runs?: number;
	/** the profiler secret (`x-profiler-key`); none on a dev server */
	key?: string;
	/** the profiler's base path (default `/__profiler`) */
	base?: string;
	fetch?: typeof globalThis.fetch;
	/** per-page timeout, ms (a page profile renders `runs` + 2 times) */
	timeout_ms?: number;
	label?: string;
	on_page?: (p: PageSnapshot) => void;
}

/** Render every page under the profiler and fold the reports into a snapshot. Pages are profiled
 *  one at a time (the server has one recorder); a page that fails throws with the reason. */
export async function measure(opts: MeasureOptions): Promise<PerfSnapshot> {
	const f = opts.fetch ?? globalThis.fetch;
	const base = (opts.base ?? '/__profiler').replace(/\/$/, '');
	const origin = opts.url.replace(/\/$/, '');
	const runs = Math.max(1, Math.min(50, opts.runs ?? 5));
	const pages: PageSnapshot[] = [];
	let node = '';
	for (const page of opts.pages) {
		if (!page.startsWith('/')) throw new Error(`page must be a path on the site: ${page}`);
		const url = `${origin}${base}/page?p=${encodeURIComponent(page)}&runs=${runs}&format=json`;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), opts.timeout_ms ?? 120_000);
		let res: Response;
		try {
			res = await f(url, { headers: { accept: 'application/json', ...(opts.key ? { 'x-profiler-key': opts.key } : {}) }, redirect: 'follow', signal: ctrl.signal });
		} catch (e) {
			throw new Error(`${page}: the profiler did not answer (${e instanceof Error ? e.message : String(e)})`);
		} finally {
			clearTimeout(timer);
		}
		if (res.status === 409) throw new Error(`${page}: the profiler is busy on that server (another recording is running)`);
		if (!res.ok) throw new Error(`${page}: the profiler answered ${res.status}${res.status === 401 || res.status === 302 || res.status === 303 ? ' — is the key right (x-profiler-key)?' : ''}`);
		let report: ReportLike;
		try {
			report = (await res.json()) as ReportLike;
		} catch {
			throw new Error(`${page}: the profiler's answer was not JSON — is ${base} the profiler's path?`);
		}
		if (!node && report.node) node = report.node;
		const snap = snapshot_page(page, report);
		pages.push(snap);
		opts.on_page?.(snap);
	}
	return { version: 1, at: Date.now(), node, ...(opts.label ? { label: opts.label } : {}), pages };
}
