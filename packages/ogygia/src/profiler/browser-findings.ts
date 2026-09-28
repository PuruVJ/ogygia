/**
 * THE BROWSER'S FINDINGS IN THE REPORT — the devtools Page tab's brain (devtools/page-insights.ts)
 * run on the visit the beacon sent, so the report and the Page tab say the same thing about the same
 * load: clicked before it woke, hydrating moved the layout, one long hydrate, waited for its turn,
 * eager below the fold, woke late, the largest paint repainted, a failed island with its error.
 *
 * The regions come from the visit itself (where each sat on the page, how it wakes, whether it
 * woke); their names from the profiled render's island rows, joined by fingerprint, then by entry.
 * Findings the report already makes its own way are left to it: a recovery (hydration-mismatch),
 * an island that never woke (never-hydrated), the vitals, the render-blocking files.
 */
import { analyze_page, type PageInput, type PageReport, type RegionFact } from '../devtools/page-insights.js';
import type { CodeKind, CpuFn, CpuSummary } from '../devtools/cpu.js';
import type { FrameCategory } from './analyze.js';
import type { ClientWindows, WindowFn } from './client-windows.js';
import type { Visit } from './visit.js';

/** codes the report makes from its own data */
const SKIP = new Set(['recovered', 'never-woke', 'render-blocking', 'vital-ttfb', 'vital-fcp', 'vital-lcp', 'vital-cls', 'vital-inp']);

export interface BrowserFinding {
	severity: 'info' | 'warn';
	code: string;
	message: string;
	fix?: string;
	/** the islands it is about (the devtools light them up on the page) */
	fps: string[];
}

function name_from_entry(entry: string): string {
	const q = entry.indexOf('?');
	const path = q === -1 ? entry : entry.slice(0, q);
	const base = path.slice(path.lastIndexOf('/') + 1);
	return base.endsWith('.svelte') ? base.slice(0, -7) : base || entry;
}

const kind_of = (c: FrameCategory): CodeKind => (c === 'component' || c === 'app' ? 'app' : c === 'dependency' ? 'dependency' : c === 'svelte' ? 'svelte' : 'browser');
const as_fn = (f: WindowFn): CpuFn => ({ name: f.name, file: f.file, line: f.line, kind: kind_of(f.category), self_ms: f.self_ms, total_ms: f.total_ms });

/** The browser's CPU cut by island, in the shape the Page tab's analysis quotes from. */
function cpu_summary(w: ClientWindows): CpuSummary {
	const islands: CpuSummary['islands'] = {};
	for (const [fp, v] of Object.entries(w.islands)) islands[fp] = { ms: v.ms, top: v.top.map(as_fn) };
	return { window_ms: 0, busy_ms: 0, by_kind: [], fns: [], files: [], islands, outside: { ms: w.outside.ms, top: w.outside.top.map(as_fn) }, interval_ms: 0 };
}

/** The Page tab's report of one visit. `rows`: the profiled render's islands (fp, entry, name);
 *  `windows`: the browser's CPU cut by island (the findings then name the function behind a cost). */
export function browser_page_report(
	visit: Visit,
	rows: readonly { fp: string; entry: string; name: string }[],
	windows?: ClientWindows,
	third?: { origin: string; named?: string[]; by_host: Map<string, number> | null },
	/** a hole's name from its island id (the report's hole rows) */
	hole_name?: (id: string) => string,
	/** a hole's server render per request, from its recorded requests */
	hole_server?: (id: string) => number | undefined
): PageReport | null {
	// (a page of holes only has neither, and a hole that kept its fallback is still worth saying)
	if (!visit.regions?.length && !visit.islands.length && !visit.holes_failed?.length && !visit.holes_answered?.length) return null;
	const by_fp = new Map(rows.map((r) => [r.fp, r.name]));
	const by_entry = new Map(rows.map((r) => [r.entry, r.name]));
	const name_of = (fp: string, entry?: string) => by_fp.get(fp) ?? (entry ? (by_entry.get(entry) ?? name_from_entry(entry)) : fp.slice(0, 8));
	const regions: RegionFact[] = (visit.regions ?? []).map((r) => {
		const kind = r.defer ? 'hole' : r.wake === 'none' ? 'lake' : 'island';
		return { fp: r.fp, name: name_of(r.fp, r.entry), kind, wake: r.wake || (kind === 'hole' ? 'fetch' : 'load'), hydrated: !!r.hydrated, top: r.top, height: r.height };
	});
	// an island that woke but is not in the regions list (an older beacon): named all the same
	const known = new Set(regions.map((r) => r.fp));
	for (const i of visit.islands)
		if (!known.has(i.fp)) {
			known.add(i.fp);
			regions.push({ fp: i.fp, name: name_of(i.fp, i.entry), kind: 'island', wake: rows.find((r) => r.fp === i.fp) ? 'load' : '', hydrated: true });
		}
	const failures = (visit.regions ?? []).filter((r) => r.failed !== undefined).map((r) => ({ fp: r.fp, message: r.failed || 'it threw' }));
	const input: PageInput = {
		vitals: visit.vitals ?? {},
		visit: {
			nav: visit.nav,
			paints: visit.paints,
			resources: visit.resources,
			resource_totals: visit.resource_totals,
			viewport: visit.viewport,
			...(visit.scripts ? { scripts: visit.scripts } : {}),
			...(visit.warnings ? { warnings: visit.warnings } : {}),
			...(third ? { origin: third.origin, ...(third.named ? { named: third.named } : {}) } : {})
		},
		islands: visit.islands,
		firsts: visit.firsts,
		shifts: visit.shifts,
		longtasks: visit.longtasks,
		// holes that kept their fallback: the same finding the devtools raise from their bus
		...(visit.holes_failed?.length
			? {
					hole_failures: visit.holes_failed.map((h) => ({
						name: hole_name?.(h.id) ?? `the hole ${h.id}`,
						reason: h.reason,
						...(h.final_path ? { final_url: h.final_path } : {}),
						...(h.message ? { message: h.message } : {}),
						attempts: h.attempts
					}))
				}
			: {}),
		// holes answered late: the fallback showed from the first paint (or the hole's own start,
		// when later) to the swap — the same measure the devtools take from their bus
		...(visit.holes_answered?.length
			? {
					hole_waits: visit.holes_answered.map((h) => {
						const server_ms = hole_server?.(h.id);
						return {
							name: hole_name?.(h.id) ?? `the hole ${h.id}`,
							wait_ms: Math.max(0, Math.round(h.t - Math.max(visit.paints?.fcp ?? 0, h.start))),
							below_fold: h.below_fold,
							...(server_ms !== undefined ? { server_ms } : {})
						};
					})
				}
			: {})
	};
	const cpu = windows ? cpu_summary(windows) : null;
	const by_host = third?.by_host ? Object.fromEntries(third.by_host) : undefined;
	return analyze_page(input, regions, failures, Infinity, cpu ? { ...cpu, by_host } : by_host ? { ...cpu_summary({ islands: {}, outside: { ms: 0, top: [] } }), by_host } : null);
}

/** The report's share of them: the codes it does not already make, severities in its two levels. */
export function browser_findings(report: PageReport | null): BrowserFinding[] {
	if (!report) return [];
	return report.findings
		.filter((f) => !SKIP.has(f.code))
		.map((f) => ({
			severity: f.severity === 'info' ? ('info' as const) : ('warn' as const),
			code: f.code,
			message: `In the browser: ${f.message}`,
			...(f.fix ? { fix: f.fix } : {}),
			fps: f.fps
		}));
}
