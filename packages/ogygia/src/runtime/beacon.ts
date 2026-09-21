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

export function beacon_mark(name: string, ms: number, attrs?: Record<string, string | number | boolean>, t0?: number): void {
	if (!endpoint() || !name) return;
	if (marks.length >= 400) return;
	marks.push({ name: String(name).slice(0, 120), ms: Math.max(0, Math.round(ms * 100) / 100), ...(t0 !== undefined ? { t0: Math.round(t0 * 100) / 100 } : {}), ...(attrs ? { attrs } : {}) });
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
	done: number;
	recovered?: boolean;
	changed?: boolean;
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
			po.observe({ type, buffered: true } as PerformanceObserverInit);
		} catch {
			// unsupported entry type
		}
	};
	observe('paint', (entries) => {
		for (const e of entries) if (e.name === 'first-contentful-paint') v.fcp = visit_paints.fcp = r2(e.startTime);
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
			if (v.inp === undefined || d > v.inp) v.inp = d;
		}
	});
	observe('longtask', (entries) => {
		for (const e of entries) if (visit_longtasks.length < 100) visit_longtasks.push({ t: r2(e.startTime), ms: r2(e.duration) });
	});
	// the first interaction inside each island: capture phase, one entry per fingerprint
	const seen = new Set<string>();
	const first = (type: string) => (ev: Event) => {
		const fp = fp_of(ev.target);
		if (!fp || seen.has(fp)) return;
		seen.add(fp);
		visit_firsts.push({ fp, t: r2(performance.now()), type });
	};
	try {
		document.addEventListener('pointerdown', first('pointer'), { capture: true, passive: true });
		document.addEventListener('keydown', first('key'), { capture: true, passive: true });
	} catch {
		// no document
	}
}

function send(body: string): void {
	const url = endpoint();
	if (!url) return;
	try {
		if (typeof navigator !== 'undefined' && navigator.sendBeacon && navigator.sendBeacon(url, body)) return;
	} catch {
		// fall through to fetch
	}
	try {
		void fetch(url, { method: 'POST', body, keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'text/plain' } });
	} catch {
		// nothing to do: the beacon is best-effort
	}
}

function flush_vitals(): void {
	if (vitals_sent || !vitals || !Object.keys(vitals).length) return;
	vitals_sent = true;
	send(JSON.stringify({ page: location.pathname, vitals }));
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
	try {
		resources = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
			.filter((r) => !r.name.includes('/__profiler/'))
			.slice(0, 200)
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
		longtasks: visit_longtasks,
		islands: visit_islands,
		firsts: visit_firsts,
		shifts: visit_shifts,
		...(visit_marks.length ? { marks: visit_marks } : {}),
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
	send(JSON.stringify({ page: location.pathname, visit }));
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

function start_cpu(): void {
	if (cpu || cpu_sent) return;
	const Ctor = (globalThis as { Profiler?: new (o: { sampleInterval: number; maxBufferSize: number }) => SelfProfiler }).Profiler;
	if (!Ctor) return;
	try {
		cpu = new Ctor({ sampleInterval: 10, maxBufferSize: 30_000 });
	} catch {
		cpu = null; // no policy on this document, or unsupported
		return;
	}
	setTimeout(() => void flush_cpu(false), CPU_WINDOW_MS);
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
	const url = endpoint();
	if (!url || !trace) return;
	const body = JSON.stringify({ page: location.pathname, cpu: trace });
	try {
		// keepalive bodies are capped at 64 KB; a trace is bigger — a plain fetch while the page
		// lives, keepalive (best effort) when it is going away
		void fetch(url, { method: 'POST', body, credentials: 'same-origin', headers: { 'content-type': 'text/plain' }, ...(hiding ? { keepalive: true } : {}) });
	} catch {
		// best effort
	}
}

function endpoint(): string | null {
	if (target !== undefined) return target;
	if (typeof document === 'undefined') return (target = null);
	const meta = document.querySelector('meta[name="ogygia-profiler-beacon"]');
	const href = meta?.getAttribute('content') ?? '';
	return (target = href ? href : null);
}

let early_visit_done = false;

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
export function beacon_hydrated(el: Element, t0: number, t_loaded: number, t_done: number, ssr_html?: string | null): void {
	if (!endpoint()) return;
	const fp = el.getAttribute('data-og-fp');
	if (!fp) return;
	const recovered = el.hasAttribute('data-og-recovered');
	queue.push({
		fp,
		entry: el.getAttribute('entry') ?? '',
		ms: Math.max(0, r2(t_done - t0)),
		load: Math.max(0, r2(t_loaded - t0)),
		...(recovered ? { recovered: true } : {})
	});
	let changed: boolean | undefined;
	if (typeof ssr_html === 'string' && visit_islands.length < 400) {
		const now = el.innerHTML;
		changed = now !== ssr_html;
		if (changed && snapshots.length < MAX_SNAPSHOTS) snapshots.push({ fp, ssr: ssr_html.slice(0, SNAPSHOT_CAP), hydrated: now.slice(0, SNAPSHOT_CAP) });
	}
	if (visit_islands.length < 400) {
		visit_islands.push({
			fp,
			...(el.getAttribute('entry') ? { entry: el.getAttribute('entry')! } : {}),
			t0: r2(t0),
			loaded: r2(t_loaded),
			done: r2(t_done),
			...(recovered ? { recovered: true } : {}),
			...(changed ? { changed: true } : {}),
			...(typeof ssr_html === 'string' ? { ssr_bytes: ssr_html.length } : {})
		});
	}
	schedule();
}

/** @internal tests */
export function _reset_beacon(): void {
	target = undefined;
	queue = [];
	marks = [];
	scheduled = false;
	vitals = null;
	vitals_sent = false;
	cpu = null;
	cpu_sent = false;
	visit_islands = [];
	visit_firsts = [];
	visit_shifts = [];
	visit_longtasks = [];
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
