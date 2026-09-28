/**
 * THE PAGE SCORE — one 0–100 number for a page, scored on what a visitor pays for, whatever built
 * the page: every byte of JS it runs at start (islands or not — a Kit-hydrated page's whole start
 * graph counts), the weight on the wire, what blocks the first paint, the HTML, the data shipped for
 * hydration, the server's render time, hydration integrity, and the browser's own vitals. A page
 * built with ogygia wins by shipping less, not because the score only looks at islands.
 *
 * CURVES, NOT CLIFFS: each metric maps to 0–100 on a log-normal curve (the one Lighthouse uses): a
 * control point where it scores 90 (`p10`) and one where it scores 50 (`median`). Twice the median
 * still scores a little, half the p10 is near 100 — every byte and millisecond moves the number.
 *
 * Pure and inputs-only so it unit-tests trivially and the curves are one place to tune. A category
 * with no measurement is DROPPED (never a free 100) and the weights renormalize — the report says
 * which were left out and why.
 */

const KB = 1024;
const MB = 1024 * 1024;

export type ScoreKey = 'js' | 'weight' | 'blocking' | 'html' | 'data' | 'hydration' | 'server' | 'loading' | 'stability' | 'responsiveness';

/** A category's contribution: its own 0–100 score, the weight it carries, and why. */
export interface ScoreCategory {
	key: ScoreKey;
	label: string;
	/** 0–100 */
	score: number;
	/** relative weight BEFORE renormalization */
	weight: number;
	/** the measured value behind the score, already formatted */
	value: string;
	/** one line: what this measures and, when it lost points, why */
	note: string;
	/** the biggest contributors (files, islands, metrics), already formatted */
	detail?: string[];
	/** the points it cost the total (its weight share × the gap to 100), filled at the end */
	lost?: number;
}

export interface PageScore {
	/** 0–100, weighted over the categories that had data */
	score: number;
	/** A ≥90, B ≥75, C ≥60, D ≥40, else F */
	grade: 'A' | 'B' | 'C' | 'D' | 'F';
	categories: ScoreCategory[];
	/** the single biggest point loss — what to fix first, or null at a top score */
	worst: ScoreCategory | null;
	/** categories left out for want of a measurement, with why */
	missing: { key: ScoreKey; label: string; why: string }[];
}

export interface ScoreAssets {
	/** JS run at start (document scripts, modulepreloads, their static imports, at-start islands), decoded */
	js: number;
	js_wire: number;
	js_files: number;
	/** JS loaded later, on demand (lazy islands), decoded */
	lazy_js: number;
	css: number;
	/** every byte at start on the wire, HTML included */
	wire: number;
	/** stylesheets + classic sync scripts in <head>, decoded */
	blocking: number;
	blocking_count: number;
	/** the biggest files, formatted `name size` */
	top?: string[];
}

export interface ScoreInputs {
	/** the page's measured weight (page-assets.ts), or null when it could not be weighed (a dev
	 *  server serves modules one by one: its graph says nothing about a build) */
	assets: ScoreAssets | null;
	/** why `assets` is null, for the report */
	assets_missing?: string;
	/** the HTML document, decoded bytes (null: not captured) */
	htmlBytes: number | null;
	/** does the page have islands at all (hydration integrity is about islands) */
	hasIslands: boolean;
	/** hydrations that discarded the server DOM and re-rendered */
	recovered: number;
	/** islands that should have woken but never reported */
	neverWoke: number;
	/** islands whose markup changed on hydration without a recovery */
	changed?: number;
	/** has the browser reported at all (no visits: integrity unknown) */
	browserSeen: boolean;
	/** data shipped for hydration: the page seed + props + remote seed + inline script text, bytes */
	dataBytes: number;
	dataDetail?: string[];
	/** SSR render time, ms (p50). null when not measured */
	serverMs: number | null;
	/** the browser's vitals over the visits, or null when none reported */
	vitals: { lcp: number | null; cls: number | null; inp: number | null; fcp?: number | null; ttfb?: number | null } | null;
	/** total blocking time from the visits' long tasks (Σ over each task of ms − 50), or null */
	tbt: number | null;
	/** measures the visiting browser could not take, with why (`tbt`, `cls`): named in `missing`,
	 *  never scored as a clean zero */
	unmeasured?: { tbt?: string; cls?: string };
}

// ── the curve ──

/** erf, Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7) — as Lighthouse's statistics module. */
function erf(x: number): number {
	const sign = Math.sign(x);
	x = Math.abs(x);
	const a1 = 0.254829592;
	const a2 = -0.284496736;
	const a3 = 1.421413741;
	const a4 = -1.453152027;
	const a5 = 1.061405429;
	const p = 0.3275911;
	const t = 1 / (1 + p * x);
	const y = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
	return sign * (1 - y * Math.exp(-x * x));
}

/** 0–100 on a log-normal curve through (p10 → 90) and (median → 50). Lower values score higher. */
export function curve(value: number, p10: number, median: number): number {
	if (!(value > 0)) return 100;
	const INVERSE_ERFC_ONE_FIFTH = 0.9061938024368232;
	const x = Math.log(value / median);
	const p10_log = -Math.log(p10 / median);
	const standardized = (x * INVERSE_ERFC_ONE_FIFTH) / p10_log;
	const s = (1 - erf(standardized)) / 2;
	// Lighthouse's rule: a raw score just under 0.9 does not round into the green
	const n = Math.round(s * 100);
	return Math.max(0, Math.min(100, s >= 0.9 - 1e-6 ? n : Math.min(89, n)));
}

function grade_of(score: number): PageScore['grade'] {
	if (score >= 90) return 'A';
	if (score >= 75) return 'B';
	if (score >= 60) return 'C';
	if (score >= 40) return 'D';
	return 'F';
}

export function fmt_bytes(bytes: number): string {
	if (bytes >= MB) return `${(bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1)} MB`;
	if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
	return `${bytes} B`;
}

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

/** The control points, in one place: [p10 (scores 90), median (scores 50)]. */
export const CURVES = {
	js: [150 * KB, 700 * KB],
	weight: [400 * KB, 1.6 * MB],
	blocking: [25 * KB, 150 * KB],
	html: [80 * KB, 500 * KB],
	data: [15 * KB, 150 * KB],
	server: [50, 300],
	lcp: [1200, 2500],
	fcp: [900, 1800],
	ttfb: [200, 800],
	cls: [0.05, 0.2],
	inp: [100, 300],
	tbt: [100, 400]
} as const;

/**
 * Weights (before renormalization): JS 30 · server 15 · hydration 15 · loading 10 · data 10 ·
 * weight 10 · responsiveness 10 · blocking 5 · HTML 5 · stability 5. What a visitor pays first —
 * JS to run, time to first byte, a page that works as it wakes — carries the most.
 */
export function page_score(inp: ScoreInputs): PageScore {
	const cats: ScoreCategory[] = [];
	const missing: PageScore['missing'] = [];

	const a = inp.assets;
	if (a) {
		const [p10, med] = CURVES.js;
		const js = curve(a.js, p10, med);
		cats.push({
			key: 'js',
			label: 'JS at start',
			score: js,
			// the heaviest weight, visit or not: a visit is the developer's own fast machine, where
			// parsing and running this JS costs a fraction of what a visitor's phone pays
			weight: 30,
			value: `${fmt_bytes(a.js)} in ${a.js_files} file${a.js_files === 1 ? '' : 's'}`,
			note:
				js >= 90
					? `The browser runs ${fmt_bytes(a.js)} of JS to start the page${a.lazy_js ? `; ${fmt_bytes(a.lazy_js)} more loads only when an island needs it` : ''}.`
					: `The browser downloads, parses and runs ${fmt_bytes(a.js)} of JS before the page is ready (${fmt_bytes(a.js_wire)} on the wire)${a.lazy_js ? `, plus ${fmt_bytes(a.lazy_js)} on demand` : ''}. Every script counts, not only islands: make static parts plain HTML (a lake), move heavy imports to the server, wake islands when visible or on interaction.`,
			...(a.top?.length ? { detail: a.top } : {})
		});
		const wt = curve(a.wire, CURVES.weight[0], CURVES.weight[1]);
		cats.push({
			key: 'weight',
			label: 'Page weight',
			score: wt,
			weight: 10,
			value: `${fmt_bytes(a.wire)} on the wire`,
			note: wt >= 90 ? 'Light on the wire.' : `${fmt_bytes(a.wire)} crosses the network before the page is complete (HTML, scripts, styles, fonts, images at start). Slow connections pay for every one.`
		});
		const blocking_eff = a.blocking + a.blocking_count * 8 * KB; // each blocking request costs a round trip too
		const bl = curve(blocking_eff, CURVES.blocking[0], CURVES.blocking[1]);
		cats.push({
			key: 'blocking',
			label: 'Render-blocking',
			score: bl,
			weight: 5,
			value: `${a.blocking_count} file${a.blocking_count === 1 ? '' : 's'}, ${fmt_bytes(a.blocking)}`,
			note: bl >= 90 ? 'Little stands between the HTML and the first paint.' : `${a.blocking_count} stylesheet(s) or sync script(s) in <head> (${fmt_bytes(a.blocking)}) must arrive before anything paints. Inline small CSS, merge the rest, load scripts as modules.`
		});
	} else missing.push({ key: 'js', label: 'JS, page weight, render-blocking', why: inp.assets_missing ?? 'the page could not be weighed' });

	if (inp.htmlBytes !== null) {
		const h = curve(inp.htmlBytes, CURVES.html[0], CURVES.html[1]);
		cats.push({
			key: 'html',
			label: 'HTML document',
			score: h,
			weight: 5,
			value: fmt_bytes(inp.htmlBytes),
			note: h >= 90 ? 'A compact document.' : `The HTML is ${fmt_bytes(inp.htmlBytes)}: the browser parses all of it before it is interactive. The byte strip shows which part (markup, shadow roots, props, seed) is the bulk.`
		});
	}

	{
		const d = curve(inp.dataBytes, CURVES.data[0], CURVES.data[1]);
		cats.push({
			key: 'data',
			label: 'Data shipped',
			score: d,
			weight: 10,
			value: fmt_bytes(inp.dataBytes),
			note: d >= 90 ? 'Little data rides along for hydration.' : `${fmt_bytes(inp.dataBytes)} of data (page seed, island props, inline script) ships so the browser can wake the page — serialized per request, parsed in the browser. Read fewer page.data keys in islands, pass smaller props.`,
			...(inp.dataDetail?.length ? { detail: inp.dataDetail } : {})
		});
	}

	// hydration integrity: only for a page with islands, and only once the browser reported
	if (inp.hasIslands && inp.browserSeen) {
		const changed = inp.changed ?? 0;
		const h = Math.round(100 * Math.exp(-(inp.recovered * 0.45 + inp.neverWoke * 0.35 + changed * 0.12)));
		cats.push({
			key: 'hydration',
			label: 'Hydration integrity',
			score: h,
			weight: 15,
			value: `${inp.recovered} recovered · ${inp.neverWoke} never woke${changed ? ` · ${changed} changed` : ''}`,
			note:
				h >= 99
					? 'Every island woke cleanly from its server markup.'
					: `${inp.recovered} island(s) threw away their server HTML and rendered again (a flash + a double render), ${inp.neverWoke} never woke${changed ? `, ${changed} changed their markup as they woke` : ''}. The Islands table names each and why.`
		});
	} else if (inp.hasIslands) missing.push({ key: 'hydration', label: 'Hydration integrity', why: 'no browser visit reported yet (open the page with the profiler on)' });

	if (inp.serverMs !== null) {
		const s = curve(inp.serverMs, CURVES.server[0], CURVES.server[1]);
		cats.push({
			key: 'server',
			label: 'Server render',
			score: s,
			weight: 15,
			value: ms(inp.serverMs),
			note: s >= 90 ? 'The server renders the page quickly.' : `${ms(inp.serverMs)} of server work before the first byte leaves. The forecast and findings above name what to cut.`
		});
	} else missing.push({ key: 'server', label: 'Server render', why: 'no server timing in this report' });

	const v = inp.vitals;
	const loading: { s: number; w: number; t: string }[] = [];
	if (v?.lcp != null) loading.push({ s: curve(v.lcp, CURVES.lcp[0], CURVES.lcp[1]), w: 60, t: `LCP ${ms(v.lcp)}` });
	if (v?.fcp != null) loading.push({ s: curve(v.fcp, CURVES.fcp[0], CURVES.fcp[1]), w: 25, t: `FCP ${ms(v.fcp)}` });
	if (v?.ttfb != null) loading.push({ s: curve(v.ttfb, CURVES.ttfb[0], CURVES.ttfb[1]), w: 15, t: `TTFB ${ms(v.ttfb)}` });
	if (loading.length) {
		const w = loading.reduce((x, p) => x + p.w, 0);
		const s = Math.round(loading.reduce((x, p) => x + p.s * p.w, 0) / w);
		cats.push({
			key: 'loading',
			label: 'Loading',
			score: s,
			weight: 10,
			value: loading.map((p) => p.t).join(' · '),
			note: s >= 90 ? 'The page paints its main content quickly.' : 'The main content took long to paint in the visits measured. A slow first byte, blocking files, or a late-loading hero image are the usual causes.',
			detail: loading.map((p) => `${p.t} → ${p.s}`)
		});
	} else missing.push({ key: 'loading', label: 'Loading (LCP/FCP/TTFB)', why: 'no browser visit reported vitals' });

	if (v?.cls != null) {
		const s = curve(v.cls, CURVES.cls[0], CURVES.cls[1]);
		cats.push({
			key: 'stability',
			label: 'Visual stability',
			score: s,
			weight: 5,
			value: `CLS ${v.cls}`,
			note: s >= 90 ? 'Nothing jumps around.' : `Content moved as the page loaded (CLS ${v.cls}). Reserve space for images and islands; render islands at their final size on the server.`
		});
	} else missing.push({ key: 'stability', label: 'Visual stability (CLS)', why: inp.unmeasured?.cls ?? 'no browser visit reported layout shifts' });

	const resp: { s: number; t: string }[] = [];
	if (v?.inp != null) resp.push({ s: curve(v.inp, CURVES.inp[0], CURVES.inp[1]), t: `INP ${ms(v.inp)}` });
	if (inp.tbt !== null) resp.push({ s: curve(inp.tbt, CURVES.tbt[0], CURVES.tbt[1]), t: `blocking time ${ms(inp.tbt)}` });
	// half measured (INP, but no long tasks from this browser): scored on what was measured, and said
	if (resp.length && inp.tbt === null && inp.unmeasured?.tbt)
		missing.push({ key: 'responsiveness', label: 'Blocking time (part of responsiveness)', why: inp.unmeasured.tbt });
	if (resp.length) {
		const s = Math.round(resp.reduce((x, p) => x + p.s, 0) / resp.length);
		cats.push({
			key: 'responsiveness',
			label: 'Responsiveness',
			score: s,
			weight: 10,
			value: resp.map((p) => p.t).join(' · '),
			note:
				(s >= 90 ? 'The main thread stayed free to answer input in the visits measured.' : 'Long tasks held the main thread in the visits measured: input waited. Less JS at start, and lighter hydration, free it.') +
				' (Measured on the machine that visited: a slower phone pays more for the same JS — which JS at start scores.)',
			detail: resp.map((p) => `${p.t} → ${p.s}`)
		});
	} else missing.push({ key: 'responsiveness', label: 'Responsiveness (INP/blocking time)', why: inp.unmeasured?.tbt ?? 'no browser visit reported long tasks or interactions' });

	const total_weight = cats.reduce((s, c) => s + c.weight, 0);
	const score = total_weight ? Math.round(cats.reduce((s, c) => s + c.score * c.weight, 0) / total_weight) : 0;
	let worst: ScoreCategory | null = null;
	for (const c of cats) {
		c.lost = Math.round(((c.weight / (total_weight || 1)) * (100 - c.score)) * 10) / 10;
		if (c.lost > 0 && (!worst || c.lost > (worst.lost ?? 0))) worst = c;
	}
	return { score, grade: grade_of(score), categories: cats, worst, missing };
}
