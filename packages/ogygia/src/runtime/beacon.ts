/**
 * THE BEACON — the browser's half of the profiler. When the document carries
 * `<meta name="ogygia-profiler-beacon" content="/__profiler/beacon">` (the profiler puts it there
 * for its own logged-in user, never for a visitor), this records what the browser saw of the page
 * and hands it over twice: to the server (so a report on a long-lived host can join it) and to
 * this browser's own IndexedDB (so a report on an ephemeral host, whose instance is gone before
 * the report is opened, still gets it — the profiler UI on the same origin reads it back).
 *
 * What it records: each island's wake (trigger → modules loaded → `data-hydrated`, and whether the
 * markup changed on the way), the app's own `mark()` timings, the web vitals, the whole VISIT —
 * navigation timing, every resource with bytes and blocking status, paints with the island the
 * largest paint sat in, long tasks, the first interaction per island, layout shifts with the
 * island they hit — the islands' markup before and after hydration (browser store only), and a
 * CPU trace of hydration where the browser allows one.
 *
 * Cost when the tag is absent: one `querySelector` on the first hydration, then a boolean. Nothing
 * here runs on the hydration path itself: samples are batched and sent on idle or when the page
 * hides.
 */

interface Sample {
	fp: string;
	entry: string;
	ms: number;
	load: number;
	/** the island discarded its server DOM and re-rendered (a hydration mismatch — something
	 *  between the server and the browser changed its markup) */
	recovered?: boolean;
	/** the named first divergence — the "why" a recovery happened (see hydrate-core). */
	reason?: string;
}

let target: string | null | undefined;
let queue: Sample[] = [];
let scheduled = false;
let listening = false;

/** MARKS: the app's own browser timings (`mark()` from ogygia/profiler/client), batched with the
 *  islands' samples and joined to the page's report next to them. */
interface Mark {
	name: string;
	ms: number;
	t0?: number;
	attrs?: Record<string, string | number | boolean>;
}
let marks: Mark[] = [];

// ONE BEACON A PAGE. Two copies of this module can land on one page: two apps' runtimes (a
// federated page), or an island reaching `ogygia/profiler/client` through another build of the
// package than the runtime's. Each copy would watch the page, run its own CPU sampler and send its
// own visit: the browser then splits its samples between two samplers, and the server gets every
// visit twice. The first copy to be called owns the page; every other copy hands its calls to it.
const BEACON_KEY = Symbol.for('ogygia.beacon');
interface BeaconApi {
	beacon_mark: typeof beacon_mark;
	beacon_failed: typeof beacon_failed;
	beacon_hydrated: typeof beacon_hydrated;
	beacon_watch: typeof beacon_watch;
	beacon_record_cpu: typeof beacon_record_cpu;
	beacon_page: typeof beacon_page;
	beacon_warning: typeof beacon_warning;
	beacon_hole_failed: typeof beacon_hole_failed;
	beacon_hole_answered?: typeof beacon_hole_answered;
}
let self_api: BeaconApi | undefined;
/** the page's owning copy when it is not this one, else null */
function owner(): BeaconApi | null {
	self_api ??= { beacon_mark, beacon_failed, beacon_hydrated, beacon_watch, beacon_record_cpu, beacon_page, beacon_warning, beacon_hole_failed, beacon_hole_answered };
	const g = globalThis as Record<symbol, BeaconApi | undefined>;
	const o = (g[BEACON_KEY] ??= self_api);
	return o === self_api ? null : o;
}

export function beacon_mark(name: string, ms: number, attrs?: Record<string, string | number | boolean>, t0?: number): void {
	const o = owner();
	if (o) return o.beacon_mark(name, ms, attrs, t0);
	if (!collecting() || !name) return;
	if (visit_marks.length >= 400) return;
	if (endpoint() && marks.length < 400) marks.push({ name: String(name).slice(0, 120), ms: Math.max(0, Math.round(ms * 100) / 100), ...(t0 !== undefined ? { t0: Math.round(t0 * 100) / 100 } : {}), ...(attrs ? { attrs } : {}) });
	visit_marks.push({ name: String(name).slice(0, 120), ms: Math.max(0, Math.round(ms * 100) / 100), ...(t0 !== undefined ? { t0: Math.round(t0 * 100) / 100 } : {}) });
	schedule();
}

// WEB VITALS for the page (the same visit the islands report from): TTFB from navigation timing,
// FCP / LCP from the paint entries, CLS as the summed unexpected shifts, INP as the longest
// interaction — observed with buffered observers so a late start still sees the early entries,
// sent once when the page hides (LCP and CLS are final only then). Best-effort: a browser without
// an entry type just leaves that field out.
interface Vitals {
	ttfb?: number;
	fcp?: number;
	lcp?: number;
	cls?: number;
	inp?: number;
}
let vitals: Vitals | null = null;
let vitals_sent = false;

// THE VISIT: everything else the browser measured, kept here until the page hides
const ISLAND_SEL = 'ogygia-region[data-og-fp]';
const r2 = (n: number) => Math.round(n * 100) / 100;
interface VisitIslandRec {
	fp: string;
	entry?: string;
	t0: number;
	loaded: number;
	/** when its scheduler turn began (after the module load and the queue behind other islands):
	 *  `done - turn` is the hydrate step alone, `turn - loaded` the wait for its turn */
	turn?: number;
	done: number;
	recovered?: boolean;
	changed?: boolean;
	/** another script edited it before it woke; the runtime put the server markup back */
	healed?: boolean;
	ssr_bytes?: number;
}
interface Shift {
	t: number;
	value: number;
	fp?: string;
	from?: [number, number, number, number];
	to?: [number, number, number, number];
}
let visit_islands: VisitIslandRec[] = [];
let visit_firsts: { fp: string; t: number; type: string }[] = [];
let visit_shifts: Shift[] = [];
let visit_longtasks: { t: number; ms: number }[] = [];
/** main-thread ms per script URL (query off), from long animation frames */
let visit_scripts = new Map<string, { ms: number; count: number }>();
/** Svelte's hydration warnings (dev): the server and the browser disagreed, Svelte kept the server's */
let visit_warnings: { code: string; message: string; file?: string; fp?: string; t: number }[] = [];

export function beacon_warning(w: { code: string; message: string; file?: string; fp?: string; t: number }): void {
	const o = owner();
	if (o) return o.beacon_warning(w);
	if (!collecting() || visit_warnings.length >= 50) return;
	visit_warnings.push(w);
	if (early_visit_done) resend_soon();
}
/** holes whose answer never came (no retry after): the profiler names them like the devtools do */
export interface HoleFailed {
	/** the hole's island id (its endpoint's `?id=`): the report's hole rows name it */
	id: string;
	reason: 'redirected' | 'document' | 'error';
	/** what answered instead, as a path (a refused answer) */
	final_path?: string;
	/** the error's first line (a failed request) */
	message?: string;
	attempts: number;
	t: number;
}
let visit_holes_failed: HoleFailed[] = [];
export function beacon_hole_failed(h: HoleFailed): void {
	const o = owner();
	if (o) return o.beacon_hole_failed(h);
	if (!collecting() || visit_holes_failed.length >= 30 || visit_holes_failed.some((x) => x.id === h.id)) return;
	visit_holes_failed.push(h);
	if (early_visit_done) resend_soon();
}
export interface HoleAnswered {
	/** the hole's island id (its endpoint's `?id=`) */
	id: string;
	/** when its fetch started, and when its answer replaced the fallback (page time, ms) */
	start: number;
	t: number;
	/** below the first screen when it swapped: its fallback was not what the visitor looked at */
	below_fold: boolean;
}
let visit_holes_answered: HoleAnswered[] = [];
/** A hole's first answer landed: the profiler weighs how long its fallback held the first screen.
 *  The element is read (id, place) only while measuring. */
export function beacon_hole_answered(el: Element, start: number): void {
	const o = owner();
	// (an older owning copy has no such entry: stay quiet)
	if (o) return o.beacon_hole_answered?.(el, start);
	if (!collecting() || visit_holes_answered.length >= 30) return;
	let id = '';
	try {
		id = new URL(el.getAttribute('endpoint') ?? '', location.href).searchParams.get('id') ?? '';
	} catch {
		id = '';
	}
	if (!id || visit_holes_answered.some((x) => x.id === id)) return;
	const rect = el.getBoundingClientRect();
	visit_holes_answered.push({ id, start: Math.round(start), t: Math.round(performance.now()), below_fold: rect.top + scrollY > innerHeight });
	if (early_visit_done) resend_soon();
}
let visit_marks: { name: string; ms: number; t0?: number }[] = [];
let visit_paints: { fcp?: number; lcp?: number; lcp_fp?: string; lcp_url?: string; lcp_tag?: string } = {};
/** an island's markup as the server sent it and after it hydrated — the browser store only */
let snapshots: { fp: string; ssr: string; hydrated: string; final?: string }[] = [];
let visit_sent = false;
const SNAPSHOT_CAP = 24_000;
const MAX_SNAPSHOTS = 40;

const fp_of = (node: unknown): string | undefined => {
	const el = node && (node as Node).nodeType === 1 ? (node as Element) : node && (node as Node).nodeType === 3 ? (node as Node).parentElement : null;
	return el?.closest?.(ISLAND_SEL)?.getAttribute('data-og-fp') ?? undefined;
};
const rect_of = (r: DOMRectReadOnly | undefined): [number, number, number, number] | undefined => (r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : undefined);

/** every resource entry the observer saw (the browser's own buffer stops at 250 by default) */
let seen_resources: PerformanceResourceTiming[] = [];
const MAX_SEEN_RESOURCES = 3000;
/** the files a visit lists one by one (the rest are in its totals by type) */
const MAX_DETAIL_RESOURCES = 200;

function observe_vitals(): void {
	if (vitals || typeof PerformanceObserver === 'undefined') return;
	const v: Vitals = (vitals = {});
	try {
		const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
		if (nav && nav.responseStart > 0) v.ttfb = r2(nav.responseStart);
	} catch {
		// no navigation timing
	}
	const observe = (type: string, cb: (entries: PerformanceEntryList) => void) => {
		try {
			const po = new PerformanceObserver((list) => cb(list.getEntries()));
			// (interactions: every one from 16 ms, the floor — the default 104 ms hides a page's INP
			// until it is already bad)
			po.observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) } as PerformanceObserverInit);
		} catch {
			// unsupported entry type
		}
	};
	observe('paint', (entries) => {
		for (const e of entries) if (e.name === 'first-contentful-paint') v.fcp = visit_paints.fcp = r2(e.startTime);
	});
	// EVERY FILE: the browser's resource buffer holds 250 entries and then drops the rest (a heavy
	// page, any dev server): room for more, and an observer, which sees each entry either way
	try {
		performance.setResourceTimingBufferSize(MAX_SEEN_RESOURCES);
	} catch {
		// unsupported
	}
	observe('resource', (entries) => {
		for (const e of entries) if (seen_resources.length < MAX_SEEN_RESOURCES) seen_resources.push(e as PerformanceResourceTiming);
	});
	observe('largest-contentful-paint', (entries) => {
		const last = entries[entries.length - 1] as (PerformanceEntry & { element?: Element | null; url?: string }) | undefined;
		if (!last) return;
		v.lcp = visit_paints.lcp = r2(last.startTime);
		const fp = fp_of(last.element);
		visit_paints.lcp_fp = fp;
		visit_paints.lcp_url = last.url || undefined;
		visit_paints.lcp_tag = last.element?.tagName?.toLowerCase();
	});
	let cls = 0;
	// no shift at all is CLS 0 (a measurement), not "unknown" — where the browser can see shifts
	try {
		if (PerformanceObserver.supportedEntryTypes?.includes('layout-shift')) v.cls = 0;
	} catch {
		// no entry-type list
	}
	observe('layout-shift', (entries) => {
		for (const e of entries as (PerformanceEntry & { hadRecentInput?: boolean; value?: number; sources?: { node?: Node | null; previousRect?: DOMRectReadOnly; currentRect?: DOMRectReadOnly }[] })[]) {
			if (e.hadRecentInput || typeof e.value !== 'number') continue;
			cls += e.value;
			if (visit_shifts.length < 60) {
				const src = e.sources?.[0];
				visit_shifts.push({ t: r2(e.startTime), value: Math.round(e.value * 10000) / 10000, ...(src?.node ? { fp: fp_of(src.node) } : {}), ...(src?.previousRect ? { from: rect_of(src.previousRect) } : {}), ...(src?.currentRect ? { to: rect_of(src.currentRect) } : {}) });
			}
		}
		v.cls = Math.round(cls * 1000) / 1000;
	});
	observe('event', (entries) => {
		for (const e of entries as (PerformanceEntry & { interactionId?: number })[]) {
			if (!e.interactionId) continue;
			const d = r2(e.duration);
			if (v.inp === undefined || d > v.inp) {
				v.inp = d;
				resend_soon();
			}
		}
	});
	observe('longtask', (entries) => {
		for (const e of entries) if (visit_longtasks.length < 100) visit_longtasks.push({ t: r2(e.startTime), ms: r2(e.duration) });
	});
	// WHICH SCRIPT held the main thread, from the page's start (buffered): the long animation frames
	// name each script that ran in them — a third party's cost is measured even before the CPU
	// sampler starts, and where the sampler cannot see into it
	observe('long-animation-frame', (entries) => {
		for (const e of entries as (PerformanceEntry & { scripts?: { sourceURL?: string; duration?: number }[] })[])
			for (const s of e.scripts ?? []) {
				const url = s.sourceURL ?? '';
				if (!url || !(s.duration && s.duration > 0)) continue;
				const q = url.indexOf('?');
				const key = (q === -1 ? url : url.slice(0, q)).slice(0, 300);
				const cur = visit_scripts.get(key);
				if (cur) {
					cur.ms += s.duration;
					cur.count++;
				} else if (visit_scripts.size < 100) visit_scripts.set(key, { ms: s.duration, count: 1 });
			}
	});
	// the first interaction inside each island: capture phase, one entry per fingerprint
	const seen = new Set<string>();
	const first = (type: string) => (ev: Event) => {
		const fp = fp_of(ev.target);
		if (!fp || seen.has(fp)) return;
		seen.add(fp);
		// when the input HAPPENED (the event's own stamp), not when this handler got to run: a click
		// that waited behind a long hydrate task still landed before the island was awake
		const at = ev.timeStamp > 0 && ev.timeStamp <= performance.now() ? ev.timeStamp : performance.now();
		visit_firsts.push({ fp, t: r2(at), type });
	};
	try {
		document.addEventListener('pointerdown', first('pointer'), { capture: true, passive: true });
		document.addEventListener('keydown', first('key'), { capture: true, passive: true });
	} catch {
		// no document
	}
}

/** sendBeacon and a keepalive fetch both refuse a body over 64 KB (UTF-16 length, with room) */
const KEEPALIVE_MAX = 60_000;

/** `slim`: the same message without what earlier messages already delivered, for a page going
 *  away with a body too big to leave (the server keeps the longest file list and merges regions).
 *  A page with ~300 islands sent 100 KB: refused by both, and the fetch's rejection went unhandled,
 *  so the profiler never got that page's browser side at all. */
function send(body: string, slim?: () => string): void {
	const url = endpoint();
	if (!url) return;
	const post = (b: string, keepalive: boolean) => {
		try {
			fetch(url, { method: 'POST', body: b, keepalive, credentials: 'same-origin', headers: { 'content-type': 'text/plain' } }).catch(() => {
				// best-effort: a dropped beacon is a missing measurement, never a page error
			});
		} catch {
			// no fetch
		}
	};
	if (body.length > KEEPALIVE_MAX) {
		// the page is still here: an ordinary request has no size limit
		if (typeof document === 'undefined' || document.visibilityState === 'visible') return post(body, false);
		const s = slim?.();
		if (!s || s.length > KEEPALIVE_MAX) return;
		body = s;
	}
	try {
		if (typeof navigator !== 'undefined' && navigator.sendBeacon && navigator.sendBeacon(url, body)) return;
	} catch {
		// fall through to fetch
	}
	post(body, true);
}

function flush_vitals(): void {
	if (vitals_sent || !vitals || !Object.keys(vitals).length) return;
	vitals_sent = true;
	// `at` = this visit (its navigation start): the copy inside the visit and this one fold into one
	send(JSON.stringify({ page: location.pathname, at: Math.round(performance.timeOrigin), vitals }));
}

/** the visit as one object: the server's copy has no snapshots (they are big and the browser
 *  store keeps them) */
function build_visit(): Record<string, unknown> | null {
	let nav: PerformanceNavigationTiming | undefined;
	try {
		nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
	} catch {
		nav = undefined;
	}
	if (!nav || !(nav.responseStart > 0)) return null;
	// no regex here: the extension by string search, once per resource
	const ext_of = (name: string): string => {
		const q = name.indexOf('?');
		const path = q === -1 ? name : name.slice(0, q);
		const dot = path.lastIndexOf('.');
		const slash = path.lastIndexOf('/');
		return dot > slash ? path.slice(dot + 1).toLowerCase() : '';
	};
	const FONT = new Set(['woff', 'woff2', 'ttf', 'otf']);
	const IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']);
	const type_of = (r: PerformanceResourceTiming): string => {
		const it = r.initiatorType;
		const ext = ext_of(r.name);
		if (FONT.has(ext)) return 'font';
		if (it === 'css' || it === 'link' || ext === 'css') return 'css';
		if (it === 'script' || ext === 'js' || ext === 'mjs') return 'script';
		if (it === 'img' || IMG.has(ext)) return 'img';
		if (it === 'fetch' || it === 'xmlhttprequest' || it === 'beacon') return 'fetch';
		return 'other';
	};
	let resources: Record<string, unknown>[] = [];
	// every file by type (the counts and bytes of ALL of them), next to the first 200 in detail
	const totals = new Map<string, { type: string; count: number; transfer: number; size: number }>();
	let all_n = 0;
	try {
		// the observer's list (it saw past the browser's buffer), else the buffer
		const listed = seen_resources.length ? seen_resources : (performance.getEntriesByType('resource') as PerformanceResourceTiming[]);
		const all = listed.filter((r) => !r.name.includes('/__profiler/'));
		all_n = all.length;
		for (const r of all) {
			const type = type_of(r);
			const t = totals.get(type) ?? { type, count: 0, transfer: 0, size: 0 };
			t.count++;
			t.transfer += r.transferSize || 0;
			t.size += r.decodedBodySize || 0;
			totals.set(type, t);
		}
		// the detail: every render-blocking file (they explain the first paint), then the earliest
		const blocking = (r: PerformanceResourceTiming) => (r as { renderBlockingStatus?: string }).renderBlockingStatus === 'blocking';
		const keep = all.filter(blocking).slice(0, MAX_DETAIL_RESOURCES);
		for (const r of all) {
			if (keep.length >= MAX_DETAIL_RESOURCES) break;
			if (!blocking(r)) keep.push(r);
		}
		keep.sort((a, b) => a.startTime - b.startTime);
		resources = keep
			.map((r) => ({
				url: r.name.slice(0, 500),
				type: type_of(r),
				start: r2(r.startTime),
				end: r2(r.responseEnd || r.startTime + r.duration),
				...(r.requestStart ? { req_start: r2(r.requestStart) } : {}),
				...(r.responseStart ? { res_start: r2(r.responseStart) } : {}),
				...(r.transferSize ? { transfer: r.transferSize } : {}),
				...(r.decodedBodySize ? { size: r.decodedBodySize } : {}),
				...((r as { renderBlockingStatus?: string }).renderBlockingStatus === 'blocking' ? { blocking: true } : {})
			}));
	} catch {
		resources = [];
	}
	return {
		at: Math.round(performance.timeOrigin),
		// (third parties are every other origin)
		origin: location.origin,
		// what this browser cannot report (Safari: layout shifts, long tasks): the server must score
		// those as unknown, never as a clean zero
		...unsupported_types(),
		nav: {
			req_start: r2(nav.requestStart),
			res_start: r2(nav.responseStart),
			res_end: r2(nav.responseEnd),
			...(nav.domInteractive ? { dom_interactive: r2(nav.domInteractive) } : {}),
			...(nav.domContentLoadedEventEnd ? { dcl: r2(nav.domContentLoadedEventEnd) } : {}),
			...(nav.loadEventEnd ? { load: r2(nav.loadEventEnd) } : {}),
			...(nav.transferSize ? { transfer: nav.transferSize } : {}),
			...(nav.decodedBodySize ? { size: nav.decodedBodySize } : {}),
			...(nav.nextHopProtocol ? { protocol: nav.nextHopProtocol } : {})
		},
		paints: visit_paints,
		resources,
		...(all_n > resources.length ? { resource_totals: [...totals.values()], resources_all: all_n } : {}),
		longtasks: visit_longtasks,
		islands: visit_islands,
		firsts: visit_firsts,
		shifts: visit_shifts,
		...(visit_scripts.size ? { scripts: [...visit_scripts].map(([url, s]) => ({ url, ms: r2(s.ms), count: s.count })).sort((a, b) => b.ms - a.ms).slice(0, 50) } : {}),
		regions: visit_regions(),
		...(visit_warnings.length ? { warnings: visit_warnings.slice() } : {}),
		...(visit_holes_failed.length ? { holes_failed: visit_holes_failed.slice() } : {}),
		...(visit_holes_answered.length ? { holes_answered: visit_holes_answered.slice() } : {}),
		...(visit_marks.length ? { marks: visit_marks } : {}),
		// the vitals so far, in every visit message (the early one, the final one): a visit whose
		// hide-time vitals message never left still reports them
		...(vitals && Object.keys(vitals).length ? { vitals: { ...vitals } } : {}),
		viewport: [innerWidth, innerHeight],
		ua: navigator.userAgent.slice(0, 200)
	};
}

/** The visit goes out twice: EARLY (on the first idle, so the store has it even if the page is
 *  torn down before a write on hide can finish) and FINAL (on hide, with the last paints, the
 *  islands' final markup and the shifts). The server and the store fold the two by navigation
 *  start. */
function flush_visit(final: boolean): void {
	if (visit_sent) return;
	const visit = build_visit();
	if (!visit) return;
	if (final) {
		visit_sent = true;
		// the islands' final markup, for the browser store's third moment
		for (const s of snapshots) {
			const el = document.querySelector(`ogygia-region[data-og-fp="${s.fp}"]`);
			if (el) {
				const html = el.innerHTML;
				if (html !== s.hydrated) s.final = html.slice(0, SNAPSHOT_CAP);
			}
		}
	}
	if (!endpoint()) return; // devtools alone: nothing leaves the page
	send(JSON.stringify({ page: location.pathname, visit }), () =>
		JSON.stringify({ page: location.pathname, visit: { ...visit, resources: [], regions: [], islands: [] } })
	);
	void store_visit({ key: `${location.pathname}|${visit.at}`, page: location.pathname, at: visit.at as number, visit, snapshots });
}

// THE BROWSER STORE: the same IndexedDB the profiler UI reads (`ui/store.ts` — one schema, two
// writers). Best-effort; a browser without it, or a private window, just keeps nothing.
const DB_NAME = 'ogygia-profiler';
const DB_VERSION = 1;
function open_db(): Promise<IDBDatabase | null> {
	return new Promise((resolve) => {
		try {
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
async function store_visit(rec: { key: string; page: string; at: number; visit: Record<string, unknown>; snapshots: { fp: string }[] }): Promise<void> {
	const db = await open_db();
	if (!db) return;
	try {
		const tx = db.transaction('visits', 'readwrite');
		const store = tx.objectStore('visits');
		// the same visit written before (the early write, or this page's other beacon instance):
		// fold the arrays so neither half is lost
		const prior = store.get(rec.key);
		prior.onsuccess = () => {
			const old = prior.result as typeof rec | undefined;
			if (old) {
				const union = <T>(xs: T[] | undefined, ys: T[] | undefined, key: (x: T) => string): T[] => {
					const m = new Map<string, T>();
					for (const x of xs ?? []) m.set(key(x), x);
					for (const y of ys ?? []) m.set(key(y), y);
					return [...m.values()];
				};
				const ov = old.visit;
				const nv = rec.visit;
				const arr = (o: unknown) => (Array.isArray(o) ? (o as Record<string, unknown>[]) : []);
				rec = {
					...rec,
					visit: {
						...ov,
						...nv,
						nav: { ...(ov.nav as object), ...(nv.nav as object) },
						paints: { ...(ov.paints as object), ...(nv.paints as object) },
						islands: union(arr(ov.islands), arr(nv.islands), (i) => `${i.fp}|${i.t0}`),
						firsts: union(arr(ov.firsts), arr(nv.firsts), (f) => String(f.fp)),
						shifts: union(arr(ov.shifts), arr(nv.shifts), (s) => `${s.t}|${s.value}`),
						longtasks: union(arr(ov.longtasks), arr(nv.longtasks), (l) => `${l.t}|${l.ms}`),
						marks: union(arr(ov.marks), arr(nv.marks), (m) => `${m.name}|${m.t0 ?? ''}|${m.ms}`),
						resources: arr(nv.resources).length >= arr(ov.resources).length ? nv.resources : ov.resources
					},
					snapshots: union(old.snapshots, rec.snapshots, (s) => s.fp)
				};
			}
			store.put(rec);
			// keep the last 30 visits: prune the oldest beyond that
			const all = store.getAllKeys();
			all.onsuccess = () => {
				const keys = (all.result as string[]).sort();
				for (const k of keys.slice(0, Math.max(0, keys.length - 30))) store.delete(k);
			};
		};
	} catch {
		// best effort
	}
}

// A CPU PROFILE OF HYDRATION (Chromium's JS Self-Profiling API): started when the beacon tag is
// found, only where the document carries the `js-profiling` policy the profiler sets for its own
// user (the constructor throws otherwise — caught, nothing happens). Stopped after a few seconds
// or when the page hides; the trace goes with a plain fetch (it is bigger than a beacon allows).
interface SelfProfiler {
	stop(): Promise<unknown>;
}
let cpu: SelfProfiler | null = null;
let cpu_sent = false;
const CPU_WINDOW_MS = 8000;
/** devtools: the load trace, and any recording started from the Page tab, kept in the page */
let cpu_kept: { trace: unknown; from: number; to: number; label: string }[] = [];
/** why there is no trace: 'unsupported' (no API), 'no-policy' (the document did not opt in) */
let cpu_off: string | null = null;
let cpu_started_at = 0;

function make_profiler(): SelfProfiler | null {
	const Ctor = (globalThis as { Profiler?: new (o: { sampleInterval: number; maxBufferSize: number }) => SelfProfiler }).Profiler;
	if (!Ctor) {
		cpu_off = 'unsupported';
		return null;
	}
	try {
		return new Ctor({ sampleInterval: 10, maxBufferSize: 30_000 });
	} catch {
		cpu_off = 'no-policy'; // the document did not opt in (Document-Policy: js-profiling)
		return null;
	}
}

/** islands that failed to hydrate (never `data-hydrated`), with the error: the CPU window does not
 *  wait for them, and the visit reports them */
const failed_fps = new Map<string, string>();
export function beacon_failed(el: Element, message?: string): void {
	const o = owner();
	if (o) return o.beacon_failed(el, message);
	if (!collecting()) return;
	const fp = el.getAttribute('data-og-fp');
	if (fp) failed_fps.set(fp, (message ?? '').slice(0, 300));
}

const MEASURED_TYPES = ['layout-shift', 'longtask', 'event', 'largest-contentful-paint', 'long-animation-frame'];
/** `{ unsupported: [...] }` for the entry types this browser cannot observe, or `{}`. */
function unsupported_types(): { unsupported?: string[] } {
	let types: readonly string[] = [];
	try {
		types = PerformanceObserver.supportedEntryTypes ?? [];
	} catch {
		return { unsupported: MEASURED_TYPES.slice() };
	}
	const missing = MEASURED_TYPES.filter((t) => !types.includes(t));
	return missing.length ? { unsupported: missing } : {};
}

/** Every region on the page as the visit ends: where it sits (document px, so the server can tell
 *  the first screen from below it), how it wakes, whether it woke, and a failure's error. One
 *  layout read per region, when a visit message is built (idle or hide), never on the hydrate path. */
function visit_regions(): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	try {
		const sy = typeof scrollY === 'number' ? scrollY : 0;
		for (const el of document.querySelectorAll('ogygia-region[data-og-fp]')) {
			if (out.length >= 400) break;
			const fp = el.getAttribute('data-og-fp')!;
			let box = el.getBoundingClientRect();
			// a display:contents host has no box: its first child with one places it
			if (!box.height && !box.width)
				for (const c of el.children) {
					const b = c.getBoundingClientRect();
					if (b.height || b.width) {
						box = b;
						break;
					}
				}
			const failed = failed_fps.get(fp);
			out.push({
				fp,
				...(el.getAttribute('entry') ? { entry: el.getAttribute('entry')! } : {}),
				...(el.getAttribute('wake') ? { wake: el.getAttribute('wake')! } : {}),
				...(el.getAttribute('render') === 'defer' ? { defer: true } : {}),
				...(el.hasAttribute('data-hydrated') ? { hydrated: true } : {}),
				...(failed !== undefined ? { failed } : {}),
				top: Math.round(box.top + sy),
				height: Math.round(box.height)
			});
		}
	} catch {
		// best effort
	}
	return out;
}

/** a slow device can still be waking islands at 8 s: keep sampling while one woke in the last
 *  1.5 s, up to 20 s — else the hydration the trace is for would be cut off */
const CPU_WINDOW_MAX_MS = 20_000;
const CPU_QUIET_MS = 1500;

function start_cpu(): void {
	if (cpu || cpu_sent || !collecting()) return;
	cpu = make_profiler();
	if (!cpu) return;
	cpu_started_at = performance.now();
	const check = () => {
		const now = performance.now();
		const last = visit_islands.length ? visit_islands[visit_islands.length - 1].done : 0;
		// still waking: one woke a moment ago, or one that wakes at load has not yet (a loaded
		// machine can be that slow — stopping now would sample the page without its hydration)
		let waiting = false;
		try {
			for (const el of document.querySelectorAll('ogygia-region[data-og-fp]:not([data-hydrated]):not([wake]):not([render="defer"]), ogygia-region[data-og-fp][wake="load"]:not([data-hydrated])'))
				if (!failed_fps.has(el.getAttribute('data-og-fp') ?? '')) {
					waiting = true;
					break;
				}
		} catch {
			waiting = false;
		}
		if ((now - last < CPU_QUIET_MS || waiting) && now - cpu_started_at < CPU_WINDOW_MAX_MS) setTimeout(check, CPU_QUIET_MS);
		else void flush_cpu(false);
	};
	setTimeout(check, CPU_WINDOW_MS);
}

async function flush_cpu(hiding: boolean): Promise<void> {
	if (!cpu || cpu_sent) return;
	const p = cpu;
	cpu = null;
	cpu_sent = true;
	let trace: unknown;
	try {
		trace = await p.stop();
	} catch {
		return;
	}
	if (DEVTOOLS && trace) cpu_kept = [{ trace, from: cpu_started_at, to: performance.now(), label: 'page load' }, ...cpu_kept.slice(0, 4)];
	const url = endpoint();
	if (!url || !trace) return;
	const body = JSON.stringify({ page: location.pathname, cpu: trace });
	// keepalive bodies are capped at 64 KB; a trace is bigger — a plain fetch while the page lives,
	// keepalive when it is going away and it fits (one that cannot fit would only fail)
	const keepalive = hiding && body.length <= KEEPALIVE_MAX;
	if (hiding && !keepalive) return;
	try {
		fetch(url, { method: 'POST', body, credentials: 'same-origin', headers: { 'content-type': 'text/plain' }, ...(keepalive ? { keepalive: true } : {}) }).catch(() => {
			// best effort
		});
	} catch {
		// no fetch
	}
}

// DEVTOOLS gate (the Vite `define`, module-local for DCE): a devtools build records the visit even
// without the profiler's tag, for the devtools Page tab to read live. It never SENDS anything
// then: the server, the browser store and the CPU trace stay behind the tag.
const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

// a BUILD with devtools on: measure only for a browser that opened the dock once (its cookie) —
// every other visitor of a preview deploy pays nothing
const DEVTOOLS_LAZY = typeof __OGYGIA_DEVTOOLS_LAZY__ !== 'undefined' ? __OGYGIA_DEVTOOLS_LAZY__ : false;
let opted: boolean | undefined;
function devtools_measures(): boolean {
	if (!DEVTOOLS) return false;
	if (!DEVTOOLS_LAZY) return true;
	if (opted === undefined) {
		try {
			opted = document.cookie.split('; ').some((c) => c === 'og_devtools=1');
		} catch {
			opted = false;
		}
	}
	return opted;
}

/** recording at all: the profiler's tag, or a devtools build (a lazy one: once opted in) */
function collecting(): boolean {
	return devtools_measures() || endpoint() !== null;
}

function endpoint(): string | null {
	if (target !== undefined) return target;
	if (typeof document === 'undefined') return (target = null);
	const meta = document.querySelector('meta[name="ogygia-profiler-beacon"]');
	const href = meta?.getAttribute('content') ?? '';
	return (target = href ? href : null);
}

let early_visit_done = false;

// A NEW WORST INTERACTION re-sends the visit a moment later (debounced; the server folds it into
// the same visit): INP is only final on hide, and a hide-time message is the one most often lost
// (a tab closed hard, a browser that drops beacons while unloading)
let resend_timer: ReturnType<typeof setTimeout> | null = null;
function resend_soon(): void {
	if (!endpoint() || visit_sent) return;
	if (resend_timer) clearTimeout(resend_timer);
	resend_timer = setTimeout(() => {
		resend_timer = null;
		flush_visit(false);
	}, 1500);
}

function flush(): void {
	scheduled = false;
	if (queue.length || marks.length) {
		// (sendBeacon sends `text/plain` without a preflight; the profiler parses the body as JSON)
		send(
			JSON.stringify({
				page: location.pathname,
				...(queue.length ? { islands: queue.splice(0, 400) } : {}),
				...(marks.length ? { marks: marks.splice(0, 400) } : {})
			})
		);
	}
	// the early visit: once, on the first idle after the first hydration
	if (!early_visit_done) {
		early_visit_done = true;
		flush_visit(false);
	}
}

/** the page is going away: the islands still queued, then the vitals (final only now), the visit */
function on_hide(): void {
	flush();
	flush_vitals();
	flush_visit(true);
	void flush_cpu(true);
}

function schedule(): void {
	if (scheduled) return;
	scheduled = true;
	if (!listening) {
		listening = true;
		observe_vitals();
		start_cpu();
		document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && on_hide());
		addEventListener('pagehide', on_hide);
	}
	const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
	if (idle) idle(flush, { timeout: 2000 });
	else setTimeout(flush, 1500);
}

/**
 * Record one island's hydration. `t0` is when the wake began (before the module load), `t_loaded`
 * when its modules were in hand, `t_done` when `data-hydrated` was set; `ssr_html` is the markup
 * the server sent (the runtime's own copy), compared with what the island shows now. No-op
 * without the tag.
 */
export function beacon_hydrated(el: Element, t0: number, t_loaded: number, t_done: number, ssr_html?: string | null, t_turn?: number): void {
	const o = owner();
	if (o) return o.beacon_hydrated(el, t0, t_loaded, t_done, ssr_html, t_turn);
	if (!collecting()) return;
	const fp = el.getAttribute('data-og-fp');
	if (!fp) return;
	const recovered = el.hasAttribute('data-og-recovered');
	// The attribute's VALUE is the named first divergence (hydrate-core's describe_divergence) — the
	// "why". Carried to the profiler so a recovered island shows the specific cause, not just a count.
	const reason = (el.getAttribute('data-og-recovered') || '').slice(0, 300) || undefined;
	// (the queue is what goes to the server: only with the tag — devtools alone reads the visit)
	if (endpoint()) queue.push({
		fp,
		entry: el.getAttribute('entry') ?? '',
		ms: Math.max(0, r2(t_done - t0)),
		load: Math.max(0, r2(t_loaded - t0)),
		...(recovered ? { recovered: true } : {}),
		...(reason ? { reason } : {})
	});
	let changed: boolean | undefined;
	if (typeof ssr_html === 'string' && visit_islands.length < 400) {
		const now = el.innerHTML;
		// compared without comments: hydration re-anchors Svelte's block markers (`<!--[-->`), which
		// nobody sees — only a change a visitor could see counts
		changed = now !== ssr_html && without_comments(now) !== without_comments(ssr_html);
		if (changed && snapshots.length < MAX_SNAPSHOTS) snapshots.push({ fp, ssr: ssr_html.slice(0, SNAPSHOT_CAP), hydrated: now.slice(0, SNAPSHOT_CAP) });
	}
	// the early visit can leave before any island wakes (the boot schedules it; a page whose scripts
	// block the wake idles first): an island waking after it re-sends the visit (debounced), rather
	// than leaving the islands to the hide-time message, the one most often lost
	if (early_visit_done) resend_soon();
	if (visit_islands.length < 400) {
		visit_islands.push({
			fp,
			...(el.getAttribute('entry') ? { entry: el.getAttribute('entry')! } : {}),
			t0: r2(t0),
			loaded: r2(t_loaded),
			...(t_turn !== undefined && t_turn >= t_loaded ? { turn: r2(t_turn) } : {}),
			done: r2(t_done),
			...(recovered ? { recovered: true } : {}),
			...(changed ? { changed: true } : {}),
			...(el.hasAttribute('data-og-healed') ? { healed: true } : {}),
			...(typeof ssr_html === 'string' ? { ssr_bytes: ssr_html.length } : {})
		});
	}
	schedule();
}

/** `html` with every `<!-- … -->` removed (string search, no regex: it runs per hydration). */
export function without_comments(html: string): string {
	let at = html.indexOf('<!--');
	if (at === -1) return html;
	let out = '';
	let from = 0;
	while (at !== -1) {
		out += html.slice(from, at);
		const end = html.indexOf('-->', at + 4);
		if (end === -1) return out; // an unclosed comment runs to the end
		from = end + 3;
		at = html.indexOf('<!--', from);
	}
	return out + html.slice(from);
}

/** Start watching the page's paints, shifts, long tasks and first interactions now (the devtools
 *  boot calls this, so a page whose islands never wake is still measured). Idempotent. */
export function beacon_watch(): void {
	const o = owner();
	if (o) return o.beacon_watch();
	if (!collecting() || typeof document === 'undefined') return;
	// the observers, the CPU sampler and the hide listeners from boot — so a page whose islands
	// never wake (or that has none) still reports its visit
	schedule();
}

/** Devtools: sample the main thread for `ms` from now (a click, a scroll, a nav) and keep the trace
 *  in the page. Resolves when it is kept; false when the browser cannot sample here. */
export async function beacon_record_cpu(ms: number, label: string): Promise<boolean> {
	const o = owner();
	if (o) return o.beacon_record_cpu(ms, label);
	if (!DEVTOOLS) return false;
	const p = make_profiler();
	if (!p) return false;
	const from = performance.now();
	await new Promise((ok) => setTimeout(ok, Math.max(200, Math.min(30_000, ms))));
	try {
		const trace = await p.stop();
		cpu_kept = [{ trace, from, to: performance.now(), label }, ...cpu_kept.slice(0, 4)];
		return true;
	} catch {
		return false;
	}
}

/** What the browser saw of this document so far, for the devtools Page tab: the vitals, the visit
 *  (navigation, paints, resources, long tasks, islands, first interactions, shifts, marks) and the
 *  islands' markup before and after hydration. A fresh copy each call; null off a devtools build
 *  without the tag. */
export interface BeaconPage {
	vitals: Vitals;
	visit: Record<string, unknown> | null;
	islands: VisitIslandRec[];
	firsts: { fp: string; t: number; type: string }[];
	shifts: Shift[];
	longtasks: { t: number; ms: number }[];
	marks: { name: string; ms: number; t0?: number }[];
	snapshots: { fp: string; ssr: string; hydrated: string; final?: string }[];
	/** the main thread, sampled (JS Self-Profiling): the load trace and recordings, newest first */
	cpu: { state: 'recording' | 'done' | 'off'; off?: string | null; traces: { trace: unknown; from: number; to: number; label: string }[] };
}
export function beacon_page(): BeaconPage | null {
	const o = owner();
	if (o) return o.beacon_page();
	if (!collecting()) return null;
	return {
		vitals: { ...(vitals ?? {}) },
		visit: build_visit(),
		islands: visit_islands.slice(),
		firsts: visit_firsts.slice(),
		shifts: visit_shifts.slice(),
		longtasks: visit_longtasks.slice(),
		marks: visit_marks.slice(),
		snapshots: snapshots.slice(),
		cpu: { state: cpu ? 'recording' : cpu_kept.length ? 'done' : 'off', off: cpu_off, traces: cpu_kept.slice() }
	};
}

/** @internal tests */
export function _reset_beacon(): void {
	const g = globalThis as Record<symbol, BeaconApi | undefined>;
	if (!self_api || g[BEACON_KEY] === self_api) delete g[BEACON_KEY];
	target = undefined;
	queue = [];
	marks = [];
	scheduled = false;
	vitals = null;
	vitals_sent = false;
	cpu = null;
	cpu_sent = false;
	cpu_kept = [];
	cpu_off = null;
	opted = undefined;
	failed_fps.clear();
	seen_resources = [];
	visit_islands = [];
	visit_firsts = [];
	visit_shifts = [];
	visit_longtasks = [];
	visit_scripts = new Map();
	visit_warnings = [];
	visit_holes_failed = [];
	visit_holes_answered = [];
	visit_marks = [];
	visit_paints = {};
	snapshots = [];
	visit_sent = false;
	early_visit_done = false;
}

/** @internal tests */
export function _beacon_state(): { target: string | null | undefined; queued: number; marks: number; scheduled: boolean; snapshots: number } {
	return { target, queued: queue.length, marks: marks.length, scheduled, snapshots: snapshots.length };
}

/** @internal tests: the size-aware send */
export const _beacon_send = send;
