/**
 * ONE VISIT, AS THE BROWSER SAW IT — the beacon's picture of a page load: navigation timing, every
 * resource with its bytes and blocking status, the paints, the long tasks, each island's wake with
 * its module load, the first interaction per island, the layout shifts with the island they hit.
 * Parsed and bounded here (the beacon is an unauthenticated-ish POST from the profiler's own user;
 * the server keeps a few per page). `one_clock` lays a visit out against the server's render on
 * one clock — the report's first picture.
 */
import { hole_segments, HOLE_SEG_LABEL } from '../devtools/hole-segments.js';
import type { PageInteraction, PageNav } from '../devtools/page-insights.js';

export interface VisitNav {
	/** ms from navigation start */
	req_start: number;
	res_start: number;
	res_end: number;
	dom_interactive?: number;
	dcl?: number;
	load?: number;
	/** the document's bytes on the wire and decoded */
	transfer?: number;
	size?: number;
	protocol?: string;
}

export interface VisitResource {
	url: string;
	/** css | script | font | img | fetch | other */
	type: string;
	start: number;
	end: number;
	req_start?: number;
	res_start?: number;
	transfer?: number;
	size?: number;
	blocking?: boolean;
}

export interface VisitIsland {
	fp: string;
	entry?: string;
	/** wake began */
	t0: number;
	/** modules in hand */
	loaded: number;
	/** its scheduler turn came (after the module; islands hydrate one per task) */
	turn?: number;
	/** `data-hydrated` set */
	done: number;
	recovered?: boolean;
	/** the island's markup changed between the server and the hydrated DOM */
	changed?: boolean;
	/** another script edited it before it woke; the runtime put the server markup back */
	healed?: boolean;
	ssr_bytes?: number;
}

export interface VisitRegion {
	fp: string;
	entry?: string;
	/** its `wake` attribute (none on a default, wake-at-load island) */
	wake?: string;
	/** a deferred hole */
	defer?: boolean;
	hydrated?: boolean;
	/** it threw while it loaded or mounted: the error */
	failed?: string;
	/** a failed island's wake → its failure (page clock) */
	failed_span?: [number, number];
	/** document px */
	top: number;
	height: number;
}

export interface VisitShift {
	t: number;
	value: number;
	/** the island whose node moved, when one did */
	fp?: string;
	/** the element that moved, told briefly */
	tag?: string;
	/** [x, y, w, h] before and after, in viewport px */
	from?: [number, number, number, number];
	to?: [number, number, number, number];
}

export interface Visit {
	page: string;
	/** epoch ms of navigation start */
	at: number;
	nav: VisitNav;
	paints: { fcp?: number; lcp?: number; lcp_fp?: string; lcp_url?: string; lcp_tag?: string };
	resources: VisitResource[];
	/** every file by type, when `resources` lists only some (the first 200, the blocking ones first) */
	resource_totals?: { type: string; count: number; transfer: number; size: number }[];
	/** how many files the page loaded in all */
	resources_all?: number;
	longtasks: { t: number; ms: number }[];
	islands: VisitIsland[];
	/** the first interaction inside an island: fingerprint, when, what kind */
	firsts: { fp: string; t: number; type: string }[];
	shifts: VisitShift[];
	marks?: { name: string; t0?: number; ms: number }[];
	/** every region on the page as the visit ended (where it sits, how it wakes, whether it woke) */
	regions?: VisitRegion[];
	/** the vitals as of this message */
	vitals?: { ttfb?: number; fcp?: number; lcp?: number; cls?: number; inp?: number };
	/** main-thread ms per script URL (long animation frames, from the page's start) */
	scripts?: { url: string; ms: number; count: number }[];
	/** the page's origin as the browser had it */
	origin?: string;
	/** entry types the visiting browser cannot observe (Safari: `layout-shift`, `longtask`): what
	 *  they would measure is unknown, not zero */
	unsupported?: string[];
	/** Svelte's hydration warnings (dev) */
	warnings?: { code: string; message: string; file?: string; fp?: string }[];
	/** holes whose answer never came, by island id (the report's hole rows name them) */
	holes_failed?: { id: string; reason: 'redirected' | 'document' | 'error'; final_path?: string; message?: string; attempts: number }[];
	/** files a preload fetched and something else downloaded again: the preload went unused */
	preload_misses?: { url: string; type: string; bytes: number; as: string; crossorigin: string | null }[];
	/** islands whose own file failed to load and fell back to their stable name */
	entry_fallbacks?: { entry: string; src: string; recovered: boolean }[];
	/** content-named files (`/immutable/`) the browser fetched again: revalidated (a 304), or
	 *  downloaded in full on a reload. `entry`: the island whose file it is; `runtime`: the runtime's */
	refetched?: { url: string; how: 'revalidated' | 'downloaded'; bytes: number; ms: number; entry?: string; hole?: string; runtime?: boolean }[];
	/** the slowest interaction (INP's), by phase, with the scripts of the long frames around it */
	interaction?: PageInteraction;
	/** the in-app navigations (router body swaps): start, page fetched, styles in, swap committed */
	navs?: PageNav[];
	/** holes whose first answer came: fetch start and swap (page time), and whether below the fold */
	holes_answered?: { id: string; n: number; start: number; t: number; below_fold: boolean; left?: number; first?: number; end?: number; queue?: number; render?: number }[];
	viewport?: [number, number];
	ua?: string;
}

const MAX_RESOURCES = 200;
const MAX_LONGTASKS = 100;
const MAX_ISLANDS = 400;
const MAX_SHIFTS = 60;
const MAX_MARKS = 200;
const MAX_MS = 600_000;

const num = (v: unknown, max = MAX_MS): number | undefined => {
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : undefined;
};
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length ? v.slice(0, max) : undefined);
const rect = (v: unknown): [number, number, number, number] | undefined => {
	if (!Array.isArray(v) || v.length !== 4) return undefined;
	const r = v.map((n) => Number(n));
	return r.every((n) => Number.isFinite(n)) ? (r.map((n) => Math.round(n)) as [number, number, number, number]) : undefined;
};
const FP_RE = /^[0-9a-f]{8,32}$/;
const KNOWN_TYPES = new Set(['layout-shift', 'longtask', 'event', 'largest-contentful-paint', 'long-animation-frame']);

/** A beacon body's `visit` → a bounded Visit, or null when it is not one. */
export function parse_visit(page: unknown, raw: unknown): Visit | null {
	if (typeof page !== 'string' || !page.startsWith('/') || page.length > 500) return null;
	const v = raw as Record<string, unknown> | null;
	if (!v || typeof v !== 'object') return null;
	const nav_raw = v.nav as Record<string, unknown> | undefined;
	if (!nav_raw || typeof nav_raw !== 'object') return null;
	const res_start = num(nav_raw.res_start);
	if (res_start === undefined) return null;
	const nav: VisitNav = {
		req_start: num(nav_raw.req_start) ?? 0,
		res_start,
		res_end: Math.max(res_start, num(nav_raw.res_end) ?? res_start)
	};
	for (const k of ['dom_interactive', 'dcl', 'load'] as const) {
		const n = num(nav_raw[k]);
		if (n !== undefined) nav[k] = n;
	}
	for (const k of ['transfer', 'size'] as const) {
		const n = num(nav_raw[k], 1e9);
		if (n !== undefined) nav[k] = n;
	}
	const proto = str(nav_raw.protocol, 16);
	if (proto) nav.protocol = proto;
	const paints_raw = (v.paints ?? {}) as Record<string, unknown>;
	const paints: Visit['paints'] = {};
	for (const k of ['fcp', 'lcp'] as const) {
		const n = num(paints_raw[k]);
		if (n !== undefined) paints[k] = n;
	}
	if (typeof paints_raw.lcp_fp === 'string' && FP_RE.test(paints_raw.lcp_fp)) paints.lcp_fp = paints_raw.lcp_fp;
	const lcp_url = str(paints_raw.lcp_url, 500);
	if (lcp_url) paints.lcp_url = lcp_url;
	const lcp_tag = str(paints_raw.lcp_tag, 40);
	if (lcp_tag) paints.lcp_tag = lcp_tag;
	const resources: VisitResource[] = [];
	for (const r of (Array.isArray(v.resources) ? v.resources : []).slice(0, MAX_RESOURCES) as Record<string, unknown>[]) {
		const url = str(r?.url, 500);
		const start = num(r?.start);
		const end = num(r?.end);
		if (!url || start === undefined || end === undefined) continue;
		const out: VisitResource = { url, type: str(r.type, 16) ?? 'other', start, end: Math.max(start, end) };
		for (const k of ['req_start', 'res_start'] as const) {
			const n = num(r[k]);
			if (n !== undefined) out[k] = n;
		}
		for (const k of ['transfer', 'size'] as const) {
			const n = num(r[k], 1e9);
			if (n !== undefined) out[k] = n;
		}
		if (r.blocking === true) out.blocking = true;
		resources.push(out);
	}
	const longtasks: Visit['longtasks'] = [];
	for (const l of (Array.isArray(v.longtasks) ? v.longtasks : []).slice(0, MAX_LONGTASKS) as Record<string, unknown>[]) {
		const t = num(l?.t);
		const ms = num(l?.ms);
		if (t !== undefined && ms !== undefined) longtasks.push({ t, ms });
	}
	const islands: VisitIsland[] = [];
	for (const i of (Array.isArray(v.islands) ? v.islands : []).slice(0, MAX_ISLANDS) as Record<string, unknown>[]) {
		const fp = typeof i?.fp === 'string' && FP_RE.test(i.fp) ? i.fp : undefined;
		const t0 = num(i?.t0);
		const done = num(i?.done);
		if (!fp || t0 === undefined || done === undefined) continue;
		const out: VisitIsland = { fp, t0, loaded: Math.min(Math.max(t0, num(i.loaded) ?? t0), Math.max(t0, done)), done: Math.max(t0, done) };
		const turn = num(i.turn);
		if (turn !== undefined && turn >= out.loaded && turn <= out.done) out.turn = turn;
		const entry = str(i.entry, 300);
		if (entry) out.entry = entry;
		if (i.recovered === true) out.recovered = true;
		if (i.changed === true) out.changed = true;
		if (i.healed === true) out.healed = true;
		const sb = num(i.ssr_bytes, 1e8);
		if (sb !== undefined) out.ssr_bytes = sb;
		islands.push(out);
	}
	const firsts: Visit['firsts'] = [];
	for (const f of (Array.isArray(v.firsts) ? v.firsts : []).slice(0, MAX_ISLANDS) as Record<string, unknown>[]) {
		const fp = typeof f?.fp === 'string' && FP_RE.test(f.fp) ? f.fp : undefined;
		const t = num(f?.t);
		if (fp && t !== undefined) firsts.push({ fp, t, type: str(f.type, 24) ?? 'input' });
	}
	const shifts: VisitShift[] = [];
	for (const s of (Array.isArray(v.shifts) ? v.shifts : []).slice(0, MAX_SHIFTS) as Record<string, unknown>[]) {
		const t = num(s?.t);
		const value = num(s?.value, 100);
		if (t === undefined || value === undefined) continue;
		const out: VisitShift = { t, value };
		if (typeof s.fp === 'string' && FP_RE.test(s.fp)) out.fp = s.fp;
		const tag = str(s.tag, 100);
		if (tag) out.tag = tag;
		const from = rect(s.from);
		const to = rect(s.to);
		if (from) out.from = from;
		if (to) out.to = to;
		shifts.push(out);
	}
	const visit: Visit = { page, at: num(v.at, 1e14) ?? Date.now(), nav, paints, resources, longtasks, islands, firsts, shifts };
	const marks: NonNullable<Visit['marks']> = [];
	for (const m of (Array.isArray(v.marks) ? v.marks : []).slice(0, MAX_MARKS) as Record<string, unknown>[]) {
		const name = str(m?.name, 120);
		const ms = num(m?.ms);
		if (!name || ms === undefined) continue;
		const t0 = num(m.t0);
		marks.push({ name, ms, ...(t0 !== undefined ? { t0 } : {}) });
	}
	if (marks.length) visit.marks = marks;
	const regions: VisitRegion[] = [];
	for (const r of (Array.isArray(v.regions) ? v.regions : []).slice(0, MAX_ISLANDS) as Record<string, unknown>[]) {
		const fp = typeof r?.fp === 'string' && FP_RE.test(r.fp) ? r.fp : undefined;
		const top = Number(r?.top);
		const height = num(r?.height, 1e6);
		if (!fp || !Number.isFinite(top) || Math.abs(top) > 1e7 || height === undefined) continue;
		const out: VisitRegion = { fp, top: Math.round(top), height };
		const entry = str(r.entry, 300);
		if (entry) out.entry = entry;
		const wake = str(r.wake, 24);
		if (wake) out.wake = wake;
		if (r.defer === true) out.defer = true;
		if (r.hydrated === true) out.hydrated = true;
		if (typeof r.failed === 'string') {
			out.failed = r.failed.slice(0, 300);
			// (its wake → its failure: it was loading, holding the others' turns, meanwhile)
			const s = r.failed_span;
			if (Array.isArray(s) && s.length === 2 && typeof s[0] === 'number' && typeof s[1] === 'number' && s[0] >= 0 && s[1] >= s[0] && s[1] < MAX_MS)
				out.failed_span = [s[0], s[1]];
		}
		regions.push(out);
	}
	if (regions.length) visit.regions = regions;
	const scripts: NonNullable<Visit['scripts']> = [];
	for (const s of (Array.isArray(v.scripts) ? v.scripts : []).slice(0, 50) as Record<string, unknown>[]) {
		const url = str(s?.url, 300);
		const ms = num(s?.ms);
		if (!url || ms === undefined) continue;
		scripts.push({ url, ms, count: num(s.count, 1e6) ?? 1 });
	}
	if (scripts.length) visit.scripts = scripts;
	const warnings: NonNullable<Visit['warnings']> = [];
	for (const w of (Array.isArray(v.warnings) ? v.warnings : []).slice(0, 50) as Record<string, unknown>[]) {
		const code = str(w?.code, 80);
		const message = str(w?.message, 400);
		if (!code || !message) continue;
		const file = str(w.file, 300);
		const fp = typeof w.fp === 'string' && FP_RE.test(w.fp) ? w.fp : undefined;
		warnings.push({ code, message, ...(file ? { file } : {}), ...(fp ? { fp } : {}) });
	}
	if (warnings.length) visit.warnings = warnings;
	const holes_failed: NonNullable<Visit['holes_failed']> = [];
	for (const h of (Array.isArray(v.holes_failed) ? v.holes_failed : []).slice(0, 30) as Record<string, unknown>[]) {
		const id = str(h?.id, 40);
		const reason = h?.reason === 'redirected' || h?.reason === 'document' || h?.reason === 'error' ? h.reason : null;
		if (!id || !reason) continue;
		const final_path = str(h.final_path, 300);
		const message = str(h.message, 200);
		holes_failed.push({ id, reason, ...(final_path ? { final_path } : {}), ...(message ? { message } : {}), attempts: num(h.attempts, 10) ?? 1 });
	}
	if (holes_failed.length) visit.holes_failed = holes_failed;
	const preload_misses: NonNullable<Visit['preload_misses']> = [];
	for (const m of (Array.isArray(v.preload_misses) ? v.preload_misses : []).slice(0, 20) as Record<string, unknown>[]) {
		const url = str(m?.url, 500);
		const type = str(m?.type, 20);
		const bytes = num(m?.bytes, 1e9);
		if (!url || !type || bytes === undefined) continue;
		preload_misses.push({ url, type, bytes, as: str(m.as, 20) ?? '', crossorigin: typeof m.crossorigin === 'string' ? m.crossorigin.slice(0, 20) : null });
	}
	if (preload_misses.length) visit.preload_misses = preload_misses;
	const entry_fallbacks: NonNullable<Visit['entry_fallbacks']> = [];
	for (const f of (Array.isArray(v.entry_fallbacks) ? v.entry_fallbacks : []).slice(0, 20) as Record<string, unknown>[]) {
		const entry = str(f?.entry, 300);
		const src = str(f?.src, 300);
		if (!entry || !src) continue;
		entry_fallbacks.push({ entry, src, recovered: f.recovered === true });
	}
	if (entry_fallbacks.length) visit.entry_fallbacks = entry_fallbacks;
	const refetched: NonNullable<Visit['refetched']> = [];
	for (const f of (Array.isArray(v.refetched) ? v.refetched : []).slice(0, 40) as Record<string, unknown>[]) {
		const url = str(f?.url, 500);
		const how = f?.how === 'revalidated' || f?.how === 'downloaded' ? f.how : null;
		const bytes = num(f?.bytes, 1e9);
		if (!url || !how || bytes === undefined) continue;
		const entry = str(f.entry, 300);
		const hole = str(f.hole, 40);
		refetched.push({ url, how, bytes, ms: num(f.ms, 600_000) ?? 0, ...(entry ? { entry } : {}), ...(hole ? { hole } : {}), ...(f.runtime === true ? { runtime: true } : {}) });
	}
	if (refetched.length) visit.refetched = refetched;
	const navs: PageNav[] = [];
	for (const n of (Array.isArray(v.navs) ? v.navs : []).slice(0, 20) as Record<string, unknown>[]) {
		const to = str(n?.to, 300);
		const t = num(n?.t, 3_600_000);
		const fetched = num(n?.fetched, 3_600_000);
		const styled = num(n?.styled, 3_600_000);
		const swapped = num(n?.swapped, 3_600_000);
		if (!to || t === undefined || fetched === undefined || styled === undefined || swapped === undefined) continue;
		// (in order, or it is not a navigation's clock)
		if (!(t <= fetched && fetched <= styled && styled <= swapped)) continue;
		const server = num(n.server, 3_600_000);
		const download = num(n.download, 3_600_000);
		const bytes = num(n.bytes, 1e9);
		navs.push({
			from: str(n.from, 300) ?? '',
			to,
			type: str(n.type, 20) ?? 'link',
			t,
			fetched,
			styled,
			swapped,
			...(server !== undefined ? { server } : {}),
			...(download !== undefined ? { download } : {}),
			...(bytes !== undefined ? { bytes } : {}),
			...(n.prefetched === true ? { prefetched: true } : {})
		});
	}
	if (navs.length) visit.navs = navs;
	const it = v.interaction as Record<string, unknown> | undefined;
	if (it && typeof it === 'object') {
		const name = str(it.name, 40);
		const t = num(it.t);
		const ms = num(it.ms);
		if (name && t !== undefined && ms !== undefined) {
			const fp = typeof it.fp === 'string' && FP_RE.test(it.fp) ? it.fp : undefined;
			const phases = new Set(['delay', 'handler', 'paint']);
			const scripts: NonNullable<PageInteraction['scripts']> = [];
			for (const s of (Array.isArray(it.scripts) ? it.scripts : []).slice(0, 6) as Record<string, unknown>[]) {
				const sms = num(s?.ms);
				if (sms === undefined || typeof s.phase !== 'string' || !phases.has(s.phase)) continue;
				scripts.push({ url: str(s.url, 300) ?? '', fn: str(s.fn, 80) ?? '', invoker: str(s.invoker, 120) ?? '', ms: sms, phase: s.phase as 'delay' | 'handler' | 'paint' });
			}
			visit.interaction = {
				name,
				t,
				ms,
				delay: num(it.delay) ?? 0,
				processing: num(it.processing) ?? 0,
				presentation: num(it.presentation) ?? 0,
				target: str(it.target, 100) ?? '',
				...(fp ? { fp } : {}),
				...(scripts.length ? { scripts } : {})
			};
		}
	}
	const holes_answered: NonNullable<Visit['holes_answered']> = [];
	for (const h of (Array.isArray(v.holes_answered) ? v.holes_answered : []).slice(0, 30) as Record<string, unknown>[]) {
		const id = str(h?.id, 40);
		const start = num(h?.start);
		const t = num(h?.t);
		if (!id || start === undefined || t === undefined || t < start) continue;
		// the browser's timing of its request, kept only whole and in order
		const left = num(h.left);
		const first = num(h.first);
		const end = num(h.end);
		const timed = left !== undefined && first !== undefined && end !== undefined && left <= first && first <= end;
		const queue = num(h.queue);
		const render = num(h.render);
		holes_answered.push({
			id,
			// (an older beacon sends no place: its list held each id once)
			n: num(h.n, 1000) ?? holes_answered.length,
			start,
			t,
			below_fold: h.below_fold === true,
			...(timed ? { left, first, end } : {}),
			...(queue !== undefined ? { queue } : {}),
			...(render !== undefined ? { render } : {})
		});
	}
	if (holes_answered.length) visit.holes_answered = holes_answered;
	const unsupported =(Array.isArray(v.unsupported) ? v.unsupported : []).filter((t): t is string => typeof t === 'string' && KNOWN_TYPES.has(t));
	if (unsupported.length) visit.unsupported = unsupported;
	const origin = str(v.origin, 200);
	if (origin && (origin.startsWith('http://') || origin.startsWith('https://'))) visit.origin = origin;
	const totals: NonNullable<Visit['resource_totals']> = [];
	for (const t of (Array.isArray(v.resource_totals) ? v.resource_totals : []).slice(0, 12) as Record<string, unknown>[]) {
		const type = str(t?.type, 16);
		const count = num(t?.count, 1e6);
		if (!type || count === undefined) continue;
		totals.push({ type, count, transfer: num(t.transfer, 1e11) ?? 0, size: num(t.size, 1e11) ?? 0 });
	}
	const all_n = num(v.resources_all, 1e6);
	if (totals.length && all_n !== undefined && all_n > resources.length) {
		visit.resource_totals = totals;
		visit.resources_all = all_n;
	}
	const vr = v.vitals as Record<string, unknown> | undefined;
	if (vr && typeof vr === 'object') {
		const vitals: NonNullable<Visit['vitals']> = {};
		for (const k of ['ttfb', 'fcp', 'lcp', 'inp'] as const) {
			const n = num(vr[k]);
			if (n !== undefined) vitals[k] = n;
		}
		const cls = num(vr.cls, 100);
		if (cls !== undefined) vitals.cls = cls;
		if (Object.keys(vitals).length) visit.vitals = vitals;
	}
	const vp = rect([...(Array.isArray(v.viewport) ? v.viewport : []), 0, 0]);
	if (vp && vp[0] > 0 && vp[1] > 0) visit.viewport = [vp[0], vp[1]];
	const ua = str(v.ua, 200);
	if (ua) visit.ua = ua;
	return visit;
}

/** Two records of the SAME visit (same page, same navigation start) folded into one. The runtime's
 *  beacon and the app's `mark()` client can be two module instances on one page, each posting its
 *  own half (islands here, marks there); a visit is also posted early and again on hide. Arrays
 *  union by identity, the later record's navigation and paints win where it has them. */
export function merge_visits(a: Visit, b: Visit): Visit {
	const by = <T>(xs: T[], ys: T[], key: (x: T) => string): T[] => {
		const m = new Map<string, T>();
		for (const x of xs) m.set(key(x), x);
		for (const y of ys) m.set(key(y), y);
		return [...m.values()];
	};
	return {
		page: a.page,
		at: a.at,
		nav: { ...a.nav, ...b.nav },
		paints: { ...a.paints, ...b.paints },
		resources: b.resources.length >= a.resources.length ? b.resources : a.resources,
		// (the record that saw more files: the later one, as a rule)
		...((b.resources_all ?? 0) >= (a.resources_all ?? 0)
			? b.resource_totals
				? { resource_totals: b.resource_totals, resources_all: b.resources_all }
				: {}
			: { resource_totals: a.resource_totals, resources_all: a.resources_all }),
		longtasks: by(a.longtasks, b.longtasks, (l) => `${l.t}|${l.ms}`),
		islands: by(a.islands, b.islands, (i) => `${i.fp}|${i.t0}`),
		firsts: by(a.firsts, b.firsts, (f) => f.fp),
		shifts: by(a.shifts, b.shifts, (s) => `${s.t}|${s.value}`),
		...(a.marks || b.marks ? { marks: by(a.marks ?? [], b.marks ?? [], (m) => `${m.name}|${m.t0 ?? ''}|${m.ms}`) } : {}),
		// (the later record's picture of each region wins: it woke, or failed, since)
		...(a.regions || b.regions ? { regions: by(a.regions ?? [], b.regions ?? [], (r) => r.fp) } : {}),
		...(a.vitals || b.vitals ? { vitals: { ...a.vitals, ...b.vitals } } : {}),
		// (each record carries the frames so far: the later one has them all)
		...(b.scripts ?? a.scripts ? { scripts: b.scripts ?? a.scripts } : {}),
		...(b.origin ?? a.origin ? { origin: b.origin ?? a.origin } : {}),
		...(b.unsupported ?? a.unsupported ? { unsupported: b.unsupported ?? a.unsupported } : {}),
		...(b.warnings ?? a.warnings ? { warnings: b.warnings ?? a.warnings } : {}),
		// (each record carries the whole list so far: the later one has them all)
		...(b.preload_misses ?? a.preload_misses ? { preload_misses: b.preload_misses ?? a.preload_misses } : {}),
		...(b.refetched ?? a.refetched ? { refetched: b.refetched ?? a.refetched } : {}),
		...(a.navs || b.navs ? { navs: by(a.navs ?? [], b.navs ?? [], (n) => `${n.t}|${n.to}`) } : {}),
		// (the slower interaction of the two records: INP is the worst)
		...(a.interaction || b.interaction ? { interaction: !a.interaction ? b.interaction : !b.interaction ? a.interaction : b.interaction.ms >= a.interaction.ms ? b.interaction : a.interaction } : {}),
		...(a.entry_fallbacks || b.entry_fallbacks ? { entry_fallbacks: by(a.entry_fallbacks ?? [], b.entry_fallbacks ?? [], (f) => f.entry) } : {}),
		...(a.holes_failed || b.holes_failed ? { holes_failed: by(a.holes_failed ?? [], b.holes_failed ?? [], (h) => h.id) } : {}),
		...(a.holes_answered || b.holes_answered ? { holes_answered: by(a.holes_answered ?? [], b.holes_answered ?? [], (h) => `${h.n}:${h.id}`) } : {}),
		...(b.viewport ?? a.viewport ? { viewport: b.viewport ?? a.viewport } : {}),
		...(b.ua ?? a.ua ? { ua: b.ua ?? a.ua } : {})
	};
}

// ── one clock ────────────────────────────────────────────────────────────────────────────────

export interface ClockBar {
	id: string;
	lane: string;
	label: string;
	t0: number;
	t1: number;
	/** what colours it: server-<phase> | ttfb | download | css | script | font | img | fetch | other | task | island-load | island-hydrate | first */
	kind: string;
	critical?: boolean;
	detail?: string;
	fp?: string;
	blocking?: boolean;
}

export interface ClockLane {
	name: string;
	/** server | document | network | main | islands | holes */
	group: string;
	bars: ClockBar[];
}

export interface OneClock {
	/** the clock's end, ms after navigation start */
	end: number;
	lanes: ClockLane[];
	marks: { label: string; t: number; kind: string }[];
	/** the bars on the critical path to first paint and to LCP, in order */
	critical: { id: string; label: string; t0: number; t1: number; why: string }[];
	/** the server's render window, placed so it ends at the first byte (null: no server timeline) */
	server_at: { t0: number; t1: number; clipped: boolean } | null;
	notes: string[];
}

const RESOURCE_TYPES = ['css', 'script', 'font', 'img', 'fetch', 'other'];

/** Lay a visit out on one clock next to the server's render of the same page. `phases` is the
 *  server timeline's phase split (each phase's CPU + wait, in order); `names` maps an island's
 *  fingerprint to its component name. */
export function one_clock(
	visit: Visit,
	server: { window_ms: number; phases: { phase: string; label?: string; cpu_ms: number; wait_ms: number }[] } | null,
	names: Record<string, string> = {},
	/** a hole's name by its island id (the report's hole rows) */
	hole_names: Record<string, string> = {}
): OneClock {
	const lanes: ClockLane[] = [];
	const notes: string[] = [];
	if (visit.resources_all && visit.resources_all > visit.resources.length)
		notes.push(`The page loaded ${visit.resources_all} files; the lanes show ${visit.resources.length} of them (every render-blocking file, then the earliest). The counts and bytes by type cover all of them.`);
	const nav = visit.nav;
	let end = Math.max(nav.res_end, nav.load ?? 0, nav.dcl ?? 0, visit.paints.lcp ?? 0);
	// SERVER: the profiled render, aligned so it ENDS at the first byte — a different request than
	// the visit, so its length is the profile's, its place is the visit's
	let server_at: OneClock['server_at'] = null;
	if (server && server.window_ms > 0) {
		const t1 = nav.res_start;
		let t0 = t1 - server.window_ms;
		let clipped = false;
		if (t0 < 0) {
			clipped = true;
			t0 = 0;
			notes.push(`The profiled render (${Math.round(server.window_ms)} ms) is longer than this visit's time to first byte (${Math.round(t1)} ms): the visit hit a cache or a faster instance. The server bar is clipped to fit.`);
		}
		server_at = { t0, t1, clipped };
		const scale = (t1 - t0) / server.window_ms;
		const bars: ClockBar[] = [];
		let at = t0;
		for (const p of server.phases) {
			const len = (p.cpu_ms + p.wait_ms) * scale;
			if (len <= 0) continue;
			bars.push({ id: `server:${p.phase}`, lane: 'server', label: p.label ?? p.phase, t0: at, t1: at + len, kind: `server-${p.phase}`, detail: `${Math.round(p.cpu_ms)} ms CPU · ${Math.round(p.wait_ms)} ms waiting` });
			at += len;
		}
		lanes.push({ name: 'server render', group: 'server', bars });
	}
	// DOCUMENT
	lanes.push({
		name: 'document',
		group: 'document',
		bars: [
			{ id: 'doc:ttfb', lane: 'document', label: 'waiting for the first byte', t0: nav.req_start, t1: nav.res_start, kind: 'ttfb', detail: `${Math.round(nav.res_start - nav.req_start)} ms from request to first byte` },
			{ id: 'doc:download', lane: 'document', label: 'HTML arriving', t0: nav.res_start, t1: nav.res_end, kind: 'download', detail: `${nav.size ? Math.round(nav.size / 1024) + ' KB' : 'the document'} over ${Math.round(nav.res_end - nav.res_start)} ms${nav.protocol ? ' · ' + nav.protocol : ''}` }
		]
	});
	// NETWORK: one lane per type, sorted by start
	const by_type = new Map<string, VisitResource[]>();
	for (const r of visit.resources) {
		const t = RESOURCE_TYPES.includes(r.type) ? r.type : 'other';
		let list = by_type.get(t);
		if (!list) by_type.set(t, (list = []));
		list.push(r);
		end = Math.max(end, r.end);
	}
	const res_bars = new Map<string, ClockBar>();
	for (const t of RESOURCE_TYPES) {
		const list = by_type.get(t);
		if (!list?.length) continue;
		const bars = list
			.sort((a, b) => a.start - b.start)
			.map((r, i) => {
				const bar: ClockBar = { id: `res:${t}:${i}`, lane: t, label: r.url.split('/').pop()?.split('?')[0] || r.url, t0: r.start, t1: r.end, kind: t, detail: `${r.transfer ? Math.round(r.transfer / 1024) + ' KB on the wire' : ''}${r.size ? ` · ${Math.round(r.size / 1024)} KB decoded` : ''}${r.blocking ? ' · render-blocking' : ''}`.replace(/^ · /, ''), ...(r.blocking ? { blocking: true } : {}) };
				res_bars.set(r.url, bar);
				return bar;
			});
		lanes.push({ name: `${t} (${bars.length})`, group: 'network', bars });
	}
	// MAIN THREAD: long tasks
	if (visit.longtasks.length) {
		lanes.push({
			name: 'main thread busy',
			group: 'main',
			bars: visit.longtasks.map((l, i) => ({ id: `task:${i}`, lane: 'main', label: `long task ${Math.round(l.ms)} ms`, t0: l.t, t1: l.t + l.ms, kind: 'task' }))
		});
		for (const l of visit.longtasks) end = Math.max(end, l.t + l.ms);
	}
	// ISLANDS: wake → loaded → hydrated, one lane per island (a few), then the first interaction
	const island_bars = new Map<string, ClockBar>();
	const islands = [...visit.islands].sort((a, b) => a.t0 - b.t0).slice(0, 40);
	if (islands.length) {
		const bars: ClockBar[] = [];
		for (const i of islands) {
			const name = names[i.fp] ?? (i.entry?.split('/').pop()?.replace(/\.[^.]+$/, '') || i.fp.slice(0, 8));
			if (i.loaded > i.t0) bars.push({ id: `island:${i.fp}:load`, lane: 'islands', label: `${name} · loading modules`, t0: i.t0, t1: i.loaded, kind: 'island-load', fp: i.fp });
			const hyd: ClockBar = { id: `island:${i.fp}`, lane: 'islands', label: `${name} · hydrating`, t0: i.loaded, t1: i.done, kind: 'island-hydrate', fp: i.fp, detail: `${Math.round(i.done - i.t0)} ms from wake, ${Math.round(i.loaded - i.t0)} of it loading${i.recovered ? ' · re-rendered (mismatch)' : ''}${i.changed ? ' · markup changed' : ''}` };
			bars.push(hyd);
			island_bars.set(i.fp, hyd);
			end = Math.max(end, i.done);
		}
		lanes.push({ name: `islands (${islands.length})`, group: 'islands', bars });
	}
	// HOLES: each first answer, cut as the devtools waterfall cuts it (hole-segments.ts): before its
	// request left, the server's render-slot wait, the render, the rest. One lane per hole (a few)
	const holes = [...(visit.holes_answered ?? [])].sort((a, b) => (a.left ?? a.start) - (b.left ?? b.start)).slice(0, 12);
	// copies of one component share a name: numbered, in the order they left
	const copies = new Map<string, number>();
	for (const h of holes) copies.set(h.id, (copies.get(h.id) ?? 0) + 1);
	const seen = new Map<string, number>();
	for (const h of holes) {
		const k = (seen.get(h.id) ?? 0) + 1;
		seen.set(h.id, k);
		const base_name = hole_names[h.id] ?? `hole ${h.id.slice(0, 8)}`;
		const name = copies.get(h.id)! > 1 ? `${base_name} ${k}` : base_name;
		const shown_at = Math.max(visit.paints.fcp ?? 0, h.start);
		const segs = hole_segments({
			shown_at,
			wait_ms: Math.max(0, h.t - shown_at),
			...(h.left !== undefined ? { left_at: h.left, first_at: h.first } : {}),
			...(h.queue !== undefined ? { server_queue_ms: h.queue } : {}),
			...(h.render !== undefined ? { server_ms: h.render } : {})
		});
		lanes.push({
			name,
			group: 'holes',
			bars: segs.map((s) => ({
				id: `hole:${h.id}:${s.k}`,
				lane: 'holes',
				label: `${name} · ${HOLE_SEG_LABEL[s.k]}`,
				t0: s.a,
				t1: s.b,
				kind: `hole-${s.k}`,
				detail: `${Math.round(s.b - s.a)} ms · its fallback stood ${Math.round(h.t - shown_at)} ms${h.below_fold ? ' (below the first screen)' : ''}`
			}))
		});
		end = Math.max(end, h.t);
	}
	const marks: OneClock['marks'] = [];
	if (visit.paints.fcp !== undefined) marks.push({ label: 'first paint', t: visit.paints.fcp, kind: 'fcp' });
	if (visit.paints.lcp !== undefined) marks.push({ label: 'largest paint', t: visit.paints.lcp, kind: 'lcp' });
	if (nav.dcl !== undefined) marks.push({ label: 'DOM ready', t: nav.dcl, kind: 'dcl' });
	if (nav.load !== undefined) marks.push({ label: 'load', t: nav.load, kind: 'load' });
	for (const f of visit.firsts.slice(0, 20)) marks.push({ label: `first ${f.type} on ${names[f.fp] ?? f.fp.slice(0, 8)}`, t: f.t, kind: 'first' });
	for (const m of visit.marks ?? []) if (m.t0 !== undefined) marks.push({ label: m.name, t: m.t0 + m.ms, kind: 'mark' });
	// CRITICAL PATH: server → first byte → the blocking stylesheet that finished last before first
	// paint → first paint; then whatever LCP waited for (an image, or the island that rendered it)
	const critical: OneClock['critical'] = [];
	const mark_critical = (bar: ClockBar | undefined, why: string) => {
		if (!bar) return;
		bar.critical = true;
		critical.push({ id: bar.id, label: bar.label, t0: bar.t0, t1: bar.t1, why });
	};
	if (server_at) {
		const srv = lanes[0].bars;
		const longest = [...srv].sort((a, b) => b.t1 - b.t0 - (a.t1 - a.t0))[0];
		mark_critical(longest, 'the biggest part of the server render');
	}
	mark_critical(lanes.find((l) => l.group === 'document')!.bars[0], 'the browser could do nothing before the first byte');
	const fcp = visit.paints.fcp;
	if (fcp !== undefined) {
		const blocking = visit.resources.filter((r) => (r.blocking || r.type === 'css') && r.end <= fcp + 5 && r.start < fcp).sort((a, b) => b.end - a.end)[0];
		if (blocking) mark_critical(res_bars.get(blocking.url), 'the last render-blocking file before first paint');
		else mark_critical(lanes.find((l) => l.group === 'document')!.bars[1], 'first paint waited for the HTML');
	}
	const lcp = visit.paints.lcp;
	if (lcp !== undefined) {
		if (visit.paints.lcp_url && res_bars.has(visit.paints.lcp_url)) mark_critical(res_bars.get(visit.paints.lcp_url), 'the largest paint is this image');
		else if (visit.paints.lcp_fp && island_bars.has(visit.paints.lcp_fp)) {
			const bar = island_bars.get(visit.paints.lcp_fp)!;
			if (bar.t1 <= lcp + 5) mark_critical(bar, 'the largest paint sits in this island, which painted after it hydrated');
		}
	}
	return { end: Math.ceil(end + 1), lanes, marks, critical, server_at, notes };
}
