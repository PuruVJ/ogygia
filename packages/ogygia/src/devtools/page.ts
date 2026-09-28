/**
 * The Page tab's DOM side: reads the regions off the page and the failures off the bus, hands them
 * with the beacon's visit to the pure {@link ./page-insights.js analyzer}. Also publishes
 * `window.__ogygia_page()` (dev-only, devtools builds) so the planted-problem answer key and e2e
 * read the same report the tab shows without opening the panel.
 */
import { beacon_page } from '../runtime/beacon.js';
import { snapshot } from './bus.js';
import { all_regions, region_name, region_names, region_transitive } from './regions.js';
import { analyze_page, type Failure, type HoleFailure, type IslandCode, type PageInput, type PageReport, type RegionFact } from './page-insights.js';
import type { BeaconPage } from '../runtime/beacon.js';
import { analyze_cpu, is_trace, type CpuSummary } from './cpu.js';
import { since_load, type LoadSnapshot, type SinceLoad } from './since-load.js';

export interface PageView {
	page: BeaconPage;
	report: PageReport;
	regions: RegionFact[];
	/** the page-load CPU trace, analyzed (null: the browser could not sample, or a navigation since) */
	cpu: CpuSummary | null;
	/** the last in-app navigation: the report covers only what happened since it */
	nav: { to: string; t: number } | null;
	/** what this browser cannot measure (a finding needing it cannot appear here) */
	unmeasured: string[];
	/** against the previous load of this same page (this tab, this session): what changed */
	since: SinceLoad | null;
	/** after an in-app navigation: islands the router KEPT from the page before (the same island with
	 *  the same props on both pages — still awake, no code, no hydrate). Without them, a page whose
	 *  islands were all reused read as "nothing woke" */
	kept?: { fp: string; name: string }[];
}

export function region_facts(): RegionFact[] {
	const sy = typeof scrollY === 'number' ? scrollY : 0;
	const out: RegionFact[] = [];
	for (const r of all_regions()) {
		if (!r.fp) continue;
		const box = r.el.getBoundingClientRect();
		out.push({
			fp: r.fp,
			name: region_name(r.entry),
			kind: r.kind,
			wake: r.wake,
			hydrated: r.hydrated,
			// (a zero box is a display:contents host: its first child places it)
			top: Math.round((box.height || box.width ? box.top : first_child_top(r.el)) + sy),
			height: Math.round(box.height)
		});
	}
	return out;
}

function first_child_top(el: Element): number {
	for (const c of el.children) {
		const b = c.getBoundingClientRect();
		if (b.height || b.width) return b.top;
	}
	return el.getBoundingClientRect().top;
}

/** This page's hydration failures, each island once: after an in-app navigation, the ones since it,
 *  and an earlier one only while its region is still on the page and still not awake (a kept
 *  island). Every visit to a page with a broken island failed it again: without this, the tab listed
 *  one failure per visit, by fingerprint, on pages that do not have the island at all. */
export function failures(since = last_nav()?.t ?? -Infinity): Failure[] {
	const out: Failure[] = [];
	const ok = new Set<string>();
	const seen = new Set<string>();
	// newest first: a later success clears an earlier failure of the same region
	const ev = snapshot();
	for (let i = ev.length - 1; i >= 0; i--) {
		const e = ev[i];
		if (e.name === 'region.hydrate.done' && e.fp) ok.add(e.fp);
		else if (e.name === 'region.hydrate.failed' && !(e.fp && ok.has(e.fp))) {
			const key = e.fp ?? e.message;
			if (seen.has(key)) continue;
			if (e.t < since && !(e.fp && document.querySelector(`ogygia-region[data-og-fp="${CSS.escape(e.fp)}"]:not([data-hydrated])`))) continue;
			seen.add(key);
			out.push({ fp: e.fp, message: e.message });
		}
	}
	return out;
}

/** Each island on the page with its dev code breakdown (the dev server's module graph: heaviest
 *  modules, barrels still imported whole). Once per component: copies share a module graph. */
function island_code(): IslandCode[] {
	const out: IslandCode[] = [];
	const seen = new Set<string>();
	for (const r of all_regions()) {
		if (r.kind !== 'island' || !r.entry || seen.has(r.entry)) continue;
		seen.add(r.entry);
		const t = region_transitive(r.entry);
		if (!t?.top?.length && !t?.barrels?.length) continue;
		out.push({ fp: r.fp ?? undefined, name: region_name(r.entry), bytes: t.bytes, top: t.top ?? [], barrels: t.barrels ?? [] });
	}
	return out;
}

/** Holes whose answer never came: the last failure of each (no retry after it), unless an answer
 *  arrived since. In a build the runtime says nothing and the page just keeps the fallback. */
export function hole_failures(since = last_nav()?.t ?? -Infinity): HoleFailure[] {
	const out: HoleFailure[] = [];
	const answered = new Set<string>();
	const seen = new Set<string>();
	const ev = snapshot();
	for (let i = ev.length - 1; i >= 0; i--) {
		const e = ev[i];
		if (e.name !== 'region.server.applied' && e.name !== 'region.server.failed') continue;
		const key = e.endpoint ?? e.entry ?? '';
		if (e.name === 'region.server.applied') answered.add(key);
		else if (e.final && !answered.has(key) && !seen.has(key) && e.t >= since) {
			seen.add(key);
			// a hole has no entry: its endpoint names the component (`?id=<island id>`)
			const el = e.endpoint ? document.querySelector(`ogygia-region[endpoint="${CSS.escape(e.endpoint)}"]`) : e.entry ? document.querySelector(`ogygia-region[entry="${CSS.escape(e.entry)}"]`) : null;
			let id = '';
			try {
				id = e.endpoint ? (new URL(e.endpoint, location.href).searchParams.get('id') ?? '') : '';
			} catch {
				id = '';
			}
			out.push({
				fp: el?.getAttribute('data-og-fp') ?? undefined,
				name: (id && region_names()[id]) || (e.entry ? region_name(e.entry) : 'a hole'),
				endpoint: e.endpoint,
				reason: e.reason,
				...(e.final_url ? { final_url: e.final_url } : {}),
				...(e.message ? { message: e.message } : {}),
				attempts: e.attempt
			});
		}
	}
	return out;
}

// one analysis per (trace, island count, long-task count): the tab re-reads every 700 ms
const cpu_memo = new WeakMap<object, { n: string; out: CpuSummary }>();

/** The CPU summary of a kept trace, against this page's island windows. */
export function cpu_of(page: BeaconPage, trace: unknown): CpuSummary | null {
	if (!is_trace(trace)) return null;
	const n = `${page.islands.length}|${page.longtasks.length}`;
	const hit = cpu_memo.get(trace);
	if (hit && hit.n === n) return hit.out;
	const windows = page.islands.map((i) => ({ fp: i.fp, from: i.turn ?? i.loaded, to: i.done }));
	const out = analyze_cpu(trace, windows, page.longtasks, location.href);
	cpu_memo.set(trace, { n, out });
	return out;
}

/** The last in-app navigation (the router's body swap): where to, and when it started. */
export function last_nav(): { to: string; t: number } | null {
	const ev = snapshot();
	for (let i = ev.length - 1; i >= 0; i--) {
		const e = ev[i];
		if (e.name === 'nav.start' && e.realm === 'client') return { to: e.to, t: e.t };
	}
	return null;
}

/**
 * After an in-app navigation the beacon's visit keeps the whole document's story on one clock: the
 * first page's islands, shifts and long tasks, then this page's. The tab is about THIS page, so its
 * events are cut to those since the navigation and shifted to start there; the paints and the
 * vitals stay the document's (a soft navigation paints nothing new the browser reports).
 */
export function since_nav(page: BeaconPage, t: number): PageInput {
	const shift = <T extends { t: number }>(xs: T[]) => xs.filter((x) => x.t >= t).map((x) => ({ ...x, t: x.t - t }));
	return {
		// (the vitals are the first page's: no finding about this page may lean on them)
		vitals: {},
		visit: page.visit ? { ...(page.visit as PageInput['visit']), paints: {}, nav: {}, resources: [] } : null,
		islands: page.islands.filter((i) => i.t0 >= t).map((i) => ({ ...i, t0: i.t0 - t, loaded: i.loaded - t, done: i.done - t, ...(i.turn !== undefined ? { turn: i.turn - t } : {}) })),
		firsts: shift(page.firsts),
		shifts: shift(page.shifts),
		longtasks: shift(page.longtasks),
		snapshots: page.snapshots
	};
}

/** Awake islands whose children slot (`<ogygia-slot>`) holds nothing: children the server never
 *  rendered (the island adopts the server's HTML; it never renders them itself). */
function empty_slots(): string[] {
	const out: string[] = [];
	for (const slot of document.querySelectorAll('ogygia-slot')) {
		let content = false;
		for (const n of slot.childNodes)
			if (n.nodeType === 1 || (n.nodeType === 3 && (n.textContent ?? '').trim())) {
				content = true;
				break;
			}
		if (content) continue;
		const region = slot.closest('ogygia-region[data-hydrated]');
		const fp = region?.getAttribute('data-og-fp');
		if (fp) out.push(fp);
	}
	return out;
}

/**
 * What THIS browser cannot measure (Safari has no layout-shift, long-task or interaction timing;
 * only Chromium has the JS sampler and long animation frames). A finding that needs one of them
 * cannot appear here — its absence is not a clean bill, and the tab says so.
 */
export function unmeasured(cpu_off?: string | null): string[] {
	let types: readonly string[] = [];
	try {
		types = PerformanceObserver.supportedEntryTypes ?? [];
	} catch {
		types = [];
	}
	const out: string[] = [];
	if (!types.includes('layout-shift')) out.push('layout shifts (CLS, a hydration that moved the layout)');
	if (!types.includes('largest-contentful-paint')) out.push('the largest paint (LCP)');
	if (!types.includes('event')) out.push('interaction timing (INP, slow interactions)');
	if (!types.includes('longtask')) out.push('long tasks');
	if (!types.includes('long-animation-frame')) out.push('which script held a frame');
	if (cpu_off === 'unsupported') out.push('the main-thread CPU (the JS sampler)');
	return out;
}

export function read_page(): PageView | null {
	const page = beacon_page();
	if (!page) return null;
	const regions = region_facts();
	const nav = last_nav();
	const load = page.cpu.traces.find((t) => t.label === 'page load');
	// (the load trace belongs to the first page: after a navigation, only a new recording is this page's)
	const cpu = load && !nav ? cpu_of(page, load.trace) : null;
	const base = nav ? since_nav(page, nav.t) : (page as unknown as PageInput);
	// third parties: every origin but this one (what the server's HTML named is not known here — the
	// live page already holds the script elements other scripts added — so parse time decides)
	const with_visit: PageInput = base.visit ? { ...base, visit: { ...base.visit, origin: location.origin } } : base;
	const holes = hole_failures();
	const code = island_code();
	const input: PageInput = { ...with_visit, empty_slots: empty_slots(), ...(holes.length ? { hole_failures: holes } : {}), ...(code.length ? { island_code: code } : {}) };
	const view: PageView = { page, regions, cpu, nav, unmeasured: unmeasured(page.cpu.off), since: null, report: analyze_page(input, regions, failures(), nav ? performance.now() - nav.t : performance.now(), cpu) };
	if (nav) {
		// awake here, and no wake since the navigation: the router reused it from the page before
		const woke = new Set(input.islands.map((i) => i.fp));
		view.kept = regions.filter((r) => r.kind === 'island' && r.hydrated && !woke.has(r.fp)).map((r) => ({ fp: r.fp, name: r.name }));
	}
	// (the first page of this document only: after an in-app navigation the vitals are not this page's)
	const prev = nav ? null : previous_load();
	if (prev) view.since = since_load(prev, snapshot_of(view));
	return view;
}

declare global {
	interface Window {
		__ogygia_page?: () => PageView | null;
		/** the Record tab's last session report (tests read what the tab shows) */
		__ogygia_session?: import('./session-insights.js').SessionReport;
		/** the Page tab's styles check, run fresh (tests read what the tab shows) */
		__ogygia_styles?: () => Promise<{ report: import('./styles.js').StylesReport; findings: import('./styles.js').StylesFinding[] }>;
	}
}

export function install_page_hook(): void {
	if (typeof window !== 'undefined' && !window.__ogygia_page) window.__ogygia_page = read_page;
	if (typeof window !== 'undefined' && !window.__ogygia_styles)
		window.__ogygia_styles = async () => {
			const { read_styles, scan_unscoped, styles_findings } = await import('./styles.js');
			const report = read_styles(document, { match: true });
			report.unscoped = await scan_unscoped(document);
			return { report, findings: styles_findings(report) };
		};
	// the picture the next load of this page is read against (the dev loop: change, reload, compare)
	if (typeof window !== 'undefined' && !hooked_hide) {
		hooked_hide = true;
		addEventListener('pagehide', () => {
			try {
				const v = read_page();
				if (v && !v.nav) sessionStorage.setItem(LOAD_KEY + location.pathname, JSON.stringify(snapshot_of(v)));
			} catch {
				// no storage
			}
		});
	}
}

// ── since your last load ──
const LOAD_KEY = 'ogygia:devtools:load:';
let hooked_hide = false;
/** the previous load's picture of THIS page, read once per document (before this load overwrites it) */
let prev_load: LoadSnapshot | null | undefined;
function previous_load(): LoadSnapshot | null {
	if (prev_load !== undefined) return prev_load;
	try {
		const raw = sessionStorage.getItem(LOAD_KEY + location.pathname);
		prev_load = raw ? (JSON.parse(raw) as LoadSnapshot) : null;
	} catch {
		prev_load = null;
	}
	return prev_load;
}

function snapshot_of(v: PageView): LoadSnapshot {
	const name = new Map(v.regions.map((r) => [r.fp, r.name]));
	return {
		path: location.pathname,
		at: Date.now(),
		findings: v.report.findings.map((f) => ({ code: f.code, names: f.fps.map((fp) => name.get(fp) ?? fp) })),
		islands: v.report.rows.map((r) => ({ name: r.name, load_ms: r.load_ms, hydrate_ms: r.hydrate_ms })),
		vitals: v.report.vitals.map((x) => ({ key: x.key, value: x.value }))
	};
}
