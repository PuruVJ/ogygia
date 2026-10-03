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
import { hole_copy_of } from './hash.js';

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
	beacon_hole_batch_missed?: typeof beacon_hole_batch_missed;
	beacon_entry_fallback?: typeof beacon_entry_fallback;
	beacon_hole_fetched?: typeof beacon_hole_fetched;
	beacon_nav?: typeof beacon_nav;
}
let self_api: BeaconApi | undefined;
/** the page's owning copy when it is not this one, else null */
function owner(): BeaconApi | null {
	self_api ??= { beacon_mark, beacon_failed, beacon_hydrated, beacon_watch, beacon_record_cpu, beacon_page, beacon_warning, beacon_hole_failed, beacon_hole_answered, beacon_hole_batch_missed, beacon_entry_fallback, beacon_hole_fetched, beacon_nav };
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
	/** when its effects had run (Svelte runs them in a microtask after `hydrate()`), when 1 ms or
	 *  more after `done`: the end of the island's own work */
	fx?: number;
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
	/** the element that moved, told briefly */
	tag?: string;
	from?: [number, number, number, number];
	to?: [number, number, number, number];
}
let visit_islands: VisitIslandRec[] = [];
let visit_firsts: { fp: string; t: number; type: string }[] = [];
let visit_shifts: Shift[] = [];
let visit_longtasks: { t: number; ms: number }[] = [];
/** main-thread ms per script URL (query off), from long animation frames */
let visit_scripts = new Map<string, { ms: number; count: number }>();
/** scripts that forced style and layout (5 ms or more), each with its window on the page's clock */
let visit_forced: { start: number; end: number; ms: number; url: string; fn: string }[] = [];
/** long frames (50 ms or more) that began while the page scrolled, with their two biggest scripts */
let visit_scroll_jank: { start: number; ms: number; scripts: { url: string; fn: string; invoker: string; ms: number }[] }[] = [];
/** when the page scrolled lately (at most one stamp per 50 ms, the last 200): the long frames are
 *  delivered after the fact, so each is matched to the scrolls around its own start */
let scroll_times: number[] = [];
const scrolled_near = (t: number) => scroll_times.some((s) => s >= t - 150 && s <= t + 50);
/** THE SLOWEST INTERACTION (the one INP reports), split the way the browser times it: the wait
 *  before its handlers ran, the handlers, and the paint after. `target`: what was clicked, told
 *  briefly; `fp`: the island it was in */
interface Interaction {
	name: string;
	t: number;
	ms: number;
	delay: number;
	processing: number;
	presentation: number;
	target: string;
	fp?: string;
}
let visit_interaction: Interaction | null = null;
/** the slowest interaction's id and its span so far (its entries arrive one by one) */
let visit_interaction_id = 0;
let visit_interaction_span: { start: number; ps: number; pe: number; end: number } | null = null;
/** the last long animation frames, each with the scripts that ran in it: what the slowest
 *  interaction waited behind, or ran, is read from the frames around it when the visit is built */
interface Frame {
	start: number;
	end: number;
	scripts: { url: string; fn: string; invoker: string; start: number; ms: number }[];
}
let visit_frames: Frame[] = [];
const MAX_FRAMES = 40;
/** Svelte's hydration warnings (dev): the server and the browser disagreed, Svelte kept the server's */
let visit_warnings: { code: string; message: string; file?: string; fp?: string; t: number }[] = [];

export function beacon_warning(w: { code: string; message: string; file?: string; fp?: string; t: number }): void {
	const o = owner();
	if (o) return o.beacon_warning(w);
	if (!collecting()) return;
	if (!make_room(visit_warnings, 50, (x) => x.t)) return;
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
const FONT_EXT = new Set(['woff', 'woff2', 'ttf', 'otf']);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']);
const LINK_AS: Record<string, string> = { style: 'css', script: 'script', font: 'font', image: 'img', fetch: 'fetch' };

/**
 * A file's type, for the byte counts and the lanes: its extension first, then the `<link>` that
 * fetched it (`as`), then what started it. A `link` initiator is NOT a stylesheet by itself: a
 * `<link rel=preload>` fetches whatever its `as` says — a hole's preload fetches HTML, from a URL
 * with no extension, and every first-screen hole answer landed in the CSS column (and One clock's
 * CSS lane). (Chromium reports a modulepreload's initiator as `other`; its `.js` decides anyway.)
 */
export function resource_type(ext: string, initiator: string, link_as?: string): string {
	if (FONT_EXT.has(ext)) return 'font';
	if (ext === 'css') return 'css';
	if (ext === 'js' || ext === 'mjs') return 'script';
	if (IMG_EXT.has(ext)) return 'img';
	if (initiator === 'link') return (link_as && LINK_AS[link_as]) || (link_as ? 'other' : 'css');
	if (initiator === 'css') return 'css';
	if (initiator === 'script') return 'script';
	if (initiator === 'img') return 'img';
	if (initiator === 'fetch' || initiator === 'xmlhttprequest' || initiator === 'beacon') return 'fetch';
	return 'other';
}

export interface HoleAnswered {
	/** the hole's island id (its endpoint's `?id=`) */
	id: string;
	/** its place in the visit's list (copies of one component share the id) */
	n: number;
	/** when its fetch started, and when its answer replaced the fallback (page time, ms) */
	start: number;
	t: number;
	/** below the first screen when it swapped: its fallback was not what the visitor looked at */
	below_fold: boolean;
	/** its request, as the browser timed it (page time): left, first byte back, last byte */
	left?: number;
	first?: number;
	end?: number;
	/** the server's split (Server-Timing): its wait for a render slot, and the render */
	queue?: number;
	render?: number;
	/** it came in ONE batch request with this many holes (`left` the batch's, `first`/`end` its
	 *  own part's landing, out of order) — no request of its own */
	batch?: number;
	/** which copy (runtime/hash.ts `hole_copy_of` its endpoint): copies of one component share the id */
	p?: string;
}

/** A batch request that carried fewer holes than it was sent for (runtime/frame-nav.ts). */
export interface HoleBatchMiss {
	sent: number;
	delivered: number;
	status: number;
	refused?: 'redirected' | 'document';
	final_url?: string;
	/** the holes' island ids */
	ids: string[];
}
let visit_hole_batches: HoleBatchMiss[] = [];

/** The restorer's log (runtime/restore.ts `__og_restore_log`): its late and mismatched hosts. */
function restore_log(): { restores?: { kind: 'late' | 'mismatch'; host: string; t: number; diff?: string; island?: string }[] } {
	const log = (globalThis as { __og_restore_log?: { kind: 'late' | 'mismatch'; host: string; t: number; diff?: string; island?: string }[] }).__og_restore_log;
	return log?.length ? { restores: log.slice(0, 20) } : {};
}
export function beacon_hole_batch_missed(m: Omit<HoleBatchMiss, 'ids'> & { endpoints: string[] }): void {
	const o = owner();
	if (o) return o.beacon_hole_batch_missed?.(m);
	if (!collecting() || visit_hole_batches.length >= 10) return;
	const ids: string[] = [];
	for (const e of m.endpoints.slice(0, 32)) {
		try {
			ids.push(new URL(e, location.href).searchParams.get('id') ?? '');
		} catch {
			ids.push('');
		}
	}
	visit_hole_batches.push({
		sent: m.sent,
		delivered: m.delivered,
		status: m.status,
		...(m.refused ? { refused: m.refused } : {}),
		...(m.final_url ? { final_url: m.final_url.slice(0, 300) } : {}),
		ids
	});
	if (early_visit_done) resend_soon();
}

/** The browser's timing of the request that answered a hole: the latest one for its URL done by
 *  `by` (the swap). It may predate the runtime (the document preloads first-screen holes). `left`
 *  is when it went on the wire (`requestStart`: after any wait for a connection), not when it was
 *  asked for. Null when the resource buffer has none (full, or no Resource Timing). */
export function hole_request_times(
	endpoint: string,
	by: number
): { left: number; first: number; end: number; queue?: number; render?: number } | null {
	try {
		const url = new URL(endpoint, location.href).href;
		let hit: PerformanceResourceTiming | undefined;
		for (const e of performance.getEntriesByName(url, 'resource') as PerformanceResourceTiming[])
			if (e.responseStart > 0 && e.responseEnd <= by + 1) hit = e;
		if (!hit) return null;
		// the server's own split, when it sent one (to a measuring browser only): its wait for a
		// render slot, and the render
		let queue: number | undefined;
		let render: number | undefined;
		for (const s of hit.serverTiming ?? []) {
			if (s.name === 'og-queue') queue = Math.round(s.duration);
			else if (s.name === 'og-render') render = Math.round(s.duration);
		}
		return {
			left: Math.round(hit.requestStart || hit.startTime),
			first: Math.round(hit.responseStart),
			end: Math.round(hit.responseEnd),
			...(queue !== undefined ? { queue } : {}),
			...(render !== undefined ? { render } : {})
		};
	} catch {
		/* no Resource Timing */
	}
	return null;
}
let visit_holes_answered: HoleAnswered[] = [];

/** An island whose LOCATION failed to load and fell back to its identity fetched fresh
 *  (runtime/entry-locations.ts): the page came from a build whose files are gone. */
export interface EntryFallback {
	/** the identity (the stable URL) */
	entry: string;
	/** the location that failed */
	src: string;
	/** the fresh identity loaded (false: that failed too) */
	recovered: boolean;
}
let visit_entry_fallbacks: EntryFallback[] = [];
export function beacon_entry_fallback(f: EntryFallback): void {
	const o = owner();
	if (o) return o.beacon_entry_fallback?.(f);
	if (!collecting() || visit_entry_fallbacks.length >= 20 || visit_entry_fallbacks.some((x) => x.entry === f.entry)) return;
	visit_entry_fallbacks.push({ entry: f.entry.slice(0, 300), src: f.src.slice(0, 300), recovered: f.recovered });
	if (early_visit_done) resend_soon();
}
/** each hole URL (absolute) → how many times the runtime asked the network for it */
let hole_fetches = new Map<string, number>();
/** The runtime asks for a hole's HTML (each ask, retries and re-asks included): what lets a
 *  preload followed by a download read as used-then-asked-again, not as a preload the browser could
 *  not use. */
export function beacon_hole_fetched(endpoint: string): void {
	const o = owner();
	if (o) return o.beacon_hole_fetched?.(endpoint);
	if (!collecting() || hole_fetches.size >= 200) return;
	try {
		const url = new URL(endpoint, location.href).href;
		hole_fetches.set(url, (hole_fetches.get(url) ?? 0) + 1);
	} catch {
		/* not a URL */
	}
}
let holes_answered_els = new WeakSet<Element>();
/** A hole's first answer landed: the profiler weighs how long its fallback held the first screen.
 *  The element is read (id, place) only while measuring. */
export function beacon_hole_answered(el: Element, start: number, batch?: { left: number; at: number; size: number }): void {
	const o = owner();
	// (an older owning copy has no such entry: stay quiet)
	if (o) return o.beacon_hole_answered?.(el, start, batch);
	if (!collecting() || visit_holes_answered.length >= 30) return;
	let id = '';
	try {
		id = new URL(el.getAttribute('endpoint') ?? '', location.href).searchParams.get('id') ?? '';
	} catch {
		id = '';
	}
	// each hole ELEMENT once: copies of one component share the id (their props differ)
	if (!id || holes_answered_els.has(el)) return;
	holes_answered_els.add(el);
	const rect = el.getBoundingClientRect();
	// a batched hole has no request of its own: the batch's departure, and its own part's landing
	const times = batch
		? { left: Math.round(batch.left), first: Math.round(batch.at), end: Math.round(batch.at), batch: batch.size }
		: hole_request_times(el.getAttribute('endpoint') ?? '', performance.now());
	visit_holes_answered.push({
		id,
		// its place in this visit's list: the early message and the final one fold by it
		n: visit_holes_answered.length,
		start: Math.round(start),
		t: Math.round(performance.now()),
		below_fold: rect.top + scrollY > innerHeight,
		// which copy (copies of one component share the id): its server requests carry the same key
		p: hole_copy_of(el.getAttribute('endpoint') ?? ''),
		...(times ?? {})
	});
	if (early_visit_done) resend_soon();
}
let visit_marks: { name: string; ms: number; t0?: number }[] = [];
let visit_paints: { fcp?: number; lcp?: number; lcp_fp?: string; lcp_url?: string; lcp_tag?: string; lcp_replaced?: true; lcp_lazy?: true } = {};
/** the largest paint's element: still in the document when the visit is read, or replaced (an
 *  island that rendered it again put a new one in its place — the hero painted twice). Only while
 *  its island is still there: an in-app navigation away takes both, and replaces nothing */
let lcp_el: Element | null = null;
let lcp_region: Element | null = null;
/** an island's markup as the server sent it and after it hydrated — the browser store only */
let snapshots: Snapshot[] = [];
let visit_sent = false;
const SNAPSHOT_CAP = 24_000;
const MAX_SNAPSHOTS = 40;

/** An island's markup as the server sent it, after it hydrated, and at the visit's end. A big
 *  island keeps only the window around where the two first differ, without comments (`from`: where
 *  the window starts in that text) — its first 24 KB would quote the cut, not the change. */
export interface Snapshot {
	fp: string;
	ssr: string;
	hydrated: string;
	final?: string;
	from?: number;
}

/** The snapshot of a changed island: whole when both fit, else the window around the change
 *  (`a`, `b`: the two markups without comments, already made for the compare). */
function snapshot_of(fp: string, ssr: string, now: string, a: string, b: string): Snapshot {
	if (ssr.length <= SNAPSHOT_CAP && now.length <= SNAPSHOT_CAP) return { fp, ssr, hydrated: now };
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	let from = Math.max(0, i - SNAPSHOT_CAP / 4);
	// (from a tag's start, so the window reads as markup)
	const lt = a.indexOf('<', from);
	if (lt !== -1 && lt <= i) from = lt;
	return { fp, ssr: a.slice(from, from + SNAPSHOT_CAP), hydrated: b.slice(from, from + SNAPSHOT_CAP), from };
}

const fp_of = (node: unknown): string | undefined => {
	const el = node && (node as Node).nodeType === 1 ? (node as Element) : node && (node as Node).nodeType === 3 ? (node as Node).parentElement : null;
	return el?.closest?.(ISLAND_SEL)?.getAttribute('data-og-fp') ?? undefined;
};
/** What was clicked, told briefly: `button "Save"`, `a#home`, `input[name=q]`. No selector engine. */
function describe_target(node: Node | null | undefined): string {
	const el = node && node.nodeType === 1 ? (node as Element) : node?.parentElement;
	if (!el) return '';
	const tag = el.tagName.toLowerCase();
	const id = el.id ? `#${el.id.slice(0, 30)}` : '';
	const name = el.getAttribute('name');
	const label = el.getAttribute('aria-label') ?? (tag === 'input' || tag === 'select' || tag === 'textarea' ? '' : (el.textContent ?? '').trim().slice(0, 30));
	return `${tag}${id}${name ? `[name=${name.slice(0, 30)}]` : ''}${label ? ` "${label}"` : ''}`;
}
const rect_of = (r: DOMRectReadOnly | undefined): [number, number, number, number] | undefined => (r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : undefined);

/** every resource entry the observer saw (the browser's own buffer stops at 250 by default) */
let seen_resources: PerformanceResourceTiming[] = [];
const MAX_SEEN_RESOURCES = 3000;
/** the files a visit lists one by one (the rest are in its totals by type) */
const MAX_DETAIL_RESOURCES = 200;
/** content-named files fetched again, at most (a page's own; the count past it is not worth more) */
const MAX_REFETCHED = 40;
/** text files (and the document) 4 KB or more sent without compression; the largest few by name */
const UNCOMPRESSED_MIN = 4096;
const MAX_UNCOMPRESSED = 10;
/** extensions that compress well (text, and wasm), whatever fetched them */
const TEXT_EXT = new Set(['js', 'mjs', 'css', 'html', 'htm', 'json', 'svg', 'txt', 'xml', 'map', 'wasm']);

function observe_vitals(): void {
	// (the page this document loaded as: its visit is filed there, whatever the router does later)
	visit_page();
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
		// (the largest paint marked loading="lazy": the browser held its fetch until layout)
		visit_paints.lcp_lazy = last.element?.getAttribute?.('loading') === 'lazy' ? true : undefined;
		lcp_el = last.element ?? null;
		lcp_region = lcp_el?.closest('ogygia-region') ?? null;
		// (a later, larger paint after the early visit — a slow hero image: sent again)
		if (early_visit_done) resend_soon();
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
			if (make_room(visit_shifts, 60, (s) => s.t)) {
				const src = e.sources?.[0];
				// (the element that moved, told briefly, for a shift outside any island: `p "Lorem…"`)
				const tag = src?.node ? describe_target(src.node) : '';
				visit_shifts.push({ t: r2(e.startTime), value: Math.round(e.value * 10000) / 10000, ...(src?.node ? { fp: fp_of(src.node) } : {}), ...(tag ? { tag } : {}), ...(src?.previousRect ? { from: rect_of(src.previousRect) } : {}), ...(src?.currentRect ? { to: rect_of(src.currentRect) } : {}) });
			}
		}
		v.cls = Math.round(cls * 1000) / 1000;
		// (a shift after the early visit: sent again, not left to the hide-time message)
		if (early_visit_done) resend_soon();
	});
	observe('event', (entries) => {
		for (const e of entries as (PerformanceEntry & { interactionId?: number; processingStart?: number; processingEnd?: number; target?: Node | null })[]) {
			if (!e.interactionId) continue;
			const d = r2(e.duration);
			// ONE INTERACTION IS SEVERAL ENTRIES (pointerdown, pointerup, click; keydown, keyup) of the
			// same length: the first alone has none of the click's handlers (a pointerdown's are
			// trivial), so every entry of the slowest interaction is folded in — its handlers run from
			// the earliest entry's start to the latest one's end, and it waited until the first began
			const same = visit_interaction_id === e.interactionId;
			if (!same && v.inp !== undefined && d <= v.inp) continue;
			if (v.inp === undefined || d > v.inp) {
				v.inp = d;
				resend_soon();
			}
			const ps = e.processingStart ?? e.startTime;
			const pe = e.processingEnd ?? ps;
			const fold = same ? visit_interaction_span : null;
			const span = (visit_interaction_span = {
				start: fold ? Math.min(fold.start, e.startTime) : e.startTime,
				ps: fold ? Math.min(fold.ps, ps) : ps,
				pe: fold ? Math.max(fold.pe, pe) : pe,
				end: fold ? Math.max(fold.end, e.startTime + e.duration) : e.startTime + e.duration
			});
			visit_interaction_id = e.interactionId;
			// (the click or the key press names it, over the pointer entries; the target is read now:
			// the node may be gone by the time the visit is built)
			const named = !same || e.name === 'click' || e.name === 'keydown' ? e : null;
			const fp = named ? fp_of(e.target) : visit_interaction?.fp;
			visit_interaction = {
				name: named ? e.name : visit_interaction!.name,
				t: r2(span.start),
				ms: r2(span.end - span.start),
				delay: r2(Math.max(0, span.ps - span.start)),
				processing: r2(Math.max(0, span.pe - span.ps)),
				presentation: r2(Math.max(0, span.end - span.pe)),
				target: named ? describe_target(e.target) || visit_interaction?.target || '' : visit_interaction!.target,
				...(fp ? { fp } : {})
			};
		}
		// (after the batch: every entry of it is folded in)
		if (visit_interaction) interaction_seen(visit_interaction);
	});
	observe('longtask', (entries) => {
		for (const e of entries) if (make_room(visit_longtasks, 100, (l) => l.t)) visit_longtasks.push({ t: r2(e.startTime), ms: r2(e.duration) });
	});
	// WHICH SCRIPT held the main thread, from the page's start (buffered): the long animation frames
	// name each script that ran in them — a third party's cost is measured even before the CPU
	// sampler starts, and where the sampler cannot see into it
	observe('long-animation-frame', (entries) => {
		for (const e of entries as (PerformanceEntry & { scripts?: { sourceURL?: string; duration?: number; startTime?: number; invoker?: string; sourceFunctionName?: string; forcedStyleAndLayoutDuration?: number }[] })[]) {
			// the scripts that made the browser lay the page out mid-run (a read after a write), with
			// when: an island's hydration runs inside the runtime's own task, so the report finds the
			// island by its hydrate window, not by the script's file
			// a long frame while the page scrolled: the visitor's scroll waited on it (the scripts in it,
			// biggest first — a scroll handler's work shows as its invoker)
			// (a frame's entry comes after it ends — often after the early visit already left, with no
			// later send due: what it says — its scripts, a forced layout, a scroll it held — would wait
			// for the page to hide, the send most often lost. /dt-thrash's forced layout missed one
			// profile of three so. The visit goes again, debounced and capped)
			if (early_visit_done) resend_soon();
			if (e.duration >= 50 && scrolled_near(e.startTime) && make_room(visit_scroll_jank, 20, (j) => j.start)) {
				visit_scroll_jank.push({
					start: r2(e.startTime),
					ms: r2(e.duration),
					scripts: (e.scripts ?? [])
						.slice()
						.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
						.slice(0, 2)
						.map((s) => ({ url: (s.sourceURL ?? '').slice(0, 300), fn: (s.sourceFunctionName ?? '').slice(0, 80), invoker: (s.invoker ?? '').slice(0, 120), ms: r2(s.duration ?? 0) }))
				});
			}
			for (const s of e.scripts ?? [])
				if ((s.forcedStyleAndLayoutDuration ?? 0) >= 5 && make_room(visit_forced, 30, (f) => f.start)) {
					const start = s.startTime ?? e.startTime;
					visit_forced.push({ start: r2(start), end: r2(start + (s.duration ?? 0)), ms: r2(s.forcedStyleAndLayoutDuration ?? 0), url: (s.sourceURL ?? '').slice(0, 300), fn: (s.sourceFunctionName ?? '').slice(0, 80) });
				}
			// each frame, kept briefly, with its scripts: what an interaction waited behind or ran
			visit_frames.push({
				start: r2(e.startTime),
				end: r2(e.startTime + e.duration),
				scripts: (e.scripts ?? []).slice(0, 8).map((s) => ({
					url: (s.sourceURL ?? '').slice(0, 300),
					fn: (s.sourceFunctionName ?? '').slice(0, 80),
					invoker: (s.invoker ?? '').slice(0, 120),
					start: r2(s.startTime ?? e.startTime),
					ms: r2(s.duration ?? 0)
				}))
			});
			if (visit_frames.length > MAX_FRAMES) visit_frames.shift();
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
		// (scrolls of the page and of any scroller: captured, passive, one stamp per 50 ms)
		document.addEventListener(
			'scroll',
			() => {
				const t = performance.now();
				if (scroll_times.length && t - scroll_times[scroll_times.length - 1] < 50) return;
				scroll_times.push(t);
				if (scroll_times.length > 200) scroll_times.shift();
			},
			{ capture: true, passive: true }
		);
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
	send(JSON.stringify({ page: visit_page(), at: Math.round(performance.timeOrigin), vitals }));
}

/** The navigation's steps before its first byte, each only when it took time (ms). */
function nav_phases(n: PerformanceNavigationTiming): { phases?: Record<string, number> } {
	const p: Record<string, number> = {};
	const put = (k: string, v: number) => {
		if (v > 0.5) p[k] = r2(v);
	};
	put('redirect', n.redirectEnd - n.redirectStart);
	if (n.workerStart > 0) put('worker', n.fetchStart - n.workerStart);
	put('dns', n.domainLookupEnd - n.domainLookupStart);
	const tls = n.secureConnectionStart > 0 ? n.connectEnd - n.secureConnectionStart : 0;
	put('connect', n.connectEnd - n.connectStart - tls);
	put('tls', tls);
	put('wait', n.responseStart - n.requestStart);
	return Object.keys(p).length ? { phases: p } : {};
}

/** The slowest interaction with the scripts of the long frames it overlapped, each put in the phase
 *  it started in: `delay` (the input waited behind it), `handler` (it ran the interaction's
 *  handlers), `paint` (after them, before the next frame). The heaviest few. */
function interaction_with_scripts(i: Interaction): Interaction & { scripts?: { url: string; fn: string; invoker: string; ms: number; phase: 'delay' | 'handler' | 'paint' }[] } {
	const end = i.t + i.ms;
	const handlers_at = i.t + i.delay;
	const paint_at = handlers_at + i.processing;
	const out: { url: string; fn: string; invoker: string; ms: number; phase: 'delay' | 'handler' | 'paint' }[] = [];
	for (const f of visit_frames) {
		if (f.end < i.t || f.start > end) continue;
		for (const s of f.scripts) {
			// (a script that ended before the input landed is not in the way; one that runs through it is)
			if (s.start + s.ms < i.t || s.start > end || !(s.ms > 0)) continue;
			const phase = s.start < handlers_at ? 'delay' : s.start <= paint_at ? 'handler' : 'paint';
			out.push({ url: s.url, fn: s.fn, invoker: s.invoker, ms: s.ms, phase });
		}
	}
	out.sort((a, b) => b.ms - a.ms);
	return out.length ? { ...i, scripts: out.slice(0, 6) } : { ...i };
}

let faces_memo: { key: string; faces: { family: string; display: string; urls: string[] }[] } | null = null;

/** The `@font-face` rules behind the fonts this page fetched: each family, its `font-display`
 *  (`auto` when unset), and the fetched files its `src` names. What says whether a late font left
 *  its text invisible. A cross-origin sheet the browser will not let us read is left out. No regex. */
function font_faces_of(fetched: ReadonlySet<string>): { family: string; display: string; urls: string[] }[] {
	if (!fetched.size) return [];
	// (each send asks again: the sheets are walked only when the fonts fetched changed)
	const key = [...fetched].join('\n');
	if (faces_memo?.key === key) return faces_memo.faces;
	const out: { family: string; display: string; urls: string[] }[] = [];
	faces_memo = { key, faces: out };
	for (const sheet of document.styleSheets) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue; // cross-origin
		}
		for (const rule of rules) {
			if (out.length >= 12) return out;
			if (!(rule instanceof CSSFontFaceRule)) continue;
			const style = rule.style;
			const src = style.getPropertyValue('src');
			const urls: string[] = [];
			let at = src.indexOf('url(');
			while (at !== -1 && urls.length < 6) {
				const end = src.indexOf(')', at);
				if (end === -1) break;
				const raw = src.slice(at + 4, end).trim().split('"').join('').split("'").join('');
				try {
					const url = new URL(raw, sheet.href ?? location.href).href.slice(0, 500);
					if (fetched.has(url)) urls.push(url);
				} catch {
					/* not a URL */
				}
				at = src.indexOf('url(', end);
			}
			if (!urls.length) continue;
			const family = style.getPropertyValue('font-family').trim().split('"').join('').split("'").join('').slice(0, 80);
			out.push({ family, display: style.getPropertyValue('font-display').trim() || 'auto', urls });
		}
	}
	return out;
}

/** IMAGES SENT FAR BIGGER THAN SHOWN: a loaded raster `<img>` whose pixels are at least 4× what
 *  its box shows on this screen (its device pixel ratio counted), and whose file is 50 KB or more —
 *  the bytes past what the box shows are bytes nobody sees. A hidden image (no box), a vector one,
 *  and one whose size the browser will not tell (cross-origin, no Timing-Allow-Origin) are left out.
 *  One layout read per send, at most 300 images. No regex. */
function oversized_images(): { url: string; natural: [number, number]; shown: [number, number]; dpr: number; bytes: number; fp?: string }[] {
	const out: ReturnType<typeof oversized_images> = [];
	const dpr = devicePixelRatio || 1;
	const imgs = document.images;
	for (let i = 0; i < imgs.length && i < 300 && out.length < 10; i++) {
		const img = imgs[i];
		if (!img.complete || !img.naturalWidth || !img.naturalHeight) continue;
		const url = img.currentSrc || img.src;
		if (!url || url.startsWith('data:')) continue;
		const q = url.indexOf('?');
		const path = (q === -1 ? url : url.slice(0, q)).toLowerCase();
		if (path.endsWith('.svg')) continue;
		const w = img.clientWidth;
		const h = img.clientHeight;
		if (!w || !h) continue;
		if (img.naturalWidth * img.naturalHeight < w * h * dpr * dpr * 4) continue;
		const e = performance.getEntriesByName(url, 'resource')[0] as PerformanceResourceTiming | undefined;
		const bytes = e ? e.encodedBodySize || e.transferSize : 0;
		if (bytes < 50_000) continue;
		const fp = fp_of(img);
		out.push({ url: url.slice(0, 500), natural: [img.naturalWidth, img.naturalHeight], shown: [w, h], dpr: r2(dpr), bytes, ...(fp ? { fp } : {}) });
	}
	return out;
}

/** PRELOADED, NEVER USED: a `<link rel="preload">` of an image, a font or a stylesheet the page
 *  fetched and, 3 s after load (when the browser itself warns), nothing on the page uses — no
 *  `<img>` / `srcset` / CSS rule names the image, no `@font-face` the font, no stylesheet link the
 *  sheet. Its bytes competed with what the first screen needed. A responsive preload
 *  (`imagesrcset`) and anything a cross-origin sheet might use are left out (it cannot be read).
 *  Asked once, after that moment; null before it. No regex. */
let preloads_memo: { url: string; as: string; bytes: number }[] | null = null;
function preloads_never_used(load_end: number): { url: string; as: string; bytes: number }[] | null {
	if (preloads_memo) return preloads_memo;
	if (!(load_end > 0) || performance.now() - load_end < 3000) return null;
	const out: { url: string; as: string; bytes: number }[] = [];
	const links = document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][href][as]');
	const css: string[] = [];
	let opaque = false;
	const faces = new Set<string>();
	let sheets_read = false;
	const read_sheets = () => {
		if (sheets_read) return;
		sheets_read = true;
		for (const sheet of document.styleSheets) {
			let rules: CSSRuleList;
			try {
				rules = sheet.cssRules;
			} catch {
				opaque = true;
				continue;
			}
			for (const rule of rules) {
				if (rule instanceof CSSFontFaceRule) {
					const src = rule.style.getPropertyValue('src');
					let at = src.indexOf('url(');
					while (at !== -1) {
						const end = src.indexOf(')', at);
						if (end === -1) break;
						try {
							faces.add(new URL(src.slice(at + 4, end).trim().split('"').join('').split("'").join(''), sheet.href ?? location.href).href);
						} catch {
							/* not a URL */
						}
						at = src.indexOf('url(', end);
					}
				} else css.push(rule.cssText);
			}
		}
	};
	for (let i = 0; i < links.length && i < 30; i++) {
		const l = links[i];
		const as = l.getAttribute('as') ?? '';
		if ((as !== 'image' && as !== 'font' && as !== 'style') || l.hasAttribute('imagesrcset')) continue;
		const url = l.href;
		const e = performance.getEntriesByName(url, 'resource')[0] as PerformanceResourceTiming | undefined;
		if (!e) continue;
		let used = false;
		if (as === 'style') {
			for (const s of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')) if (s.href === url) used = true;
		} else if (as === 'image') {
			for (const img of document.images) if (img.currentSrc === url || img.src === url || (img.srcset && img.srcset.includes(l.getAttribute('href') ?? url))) used = true;
			if (!used) for (const s of document.querySelectorAll('source[srcset]')) if ((s.getAttribute('srcset') ?? '').includes(l.getAttribute('href') ?? url)) used = true;
			if (!used) {
				read_sheets();
				const raw = l.getAttribute('href') ?? url;
				used = opaque || css.some((t) => t.includes(url) || t.includes(raw));
			}
		} else {
			read_sheets();
			used = opaque || faces.has(url);
		}
		if (!used) out.push({ url: url.slice(0, 500), as, bytes: e.encodedBodySize || e.transferSize || 0 });
	}
	preloads_memo = out;
	return out;
}

/** THE PAGE'S SIZE IN ELEMENTS, when it is big (1,500 or more): how many, the deepest nesting, the
 *  element with the most children, and the islands holding the most of them (an island hydrates
 *  over each of its own). One walk of the tree; asked again only when the count changed. */
type DomShape = { nodes: number; depth: number; deepest: string; widest: { at: string; children: number }; islands: { fp: string; nodes: number }[] };
let dom_memo: { n: number; shape: DomShape | null } | null = null;
function dom_shape(): DomShape | null {
	const all = document.getElementsByTagName('*');
	const n = all.length;
	if (dom_memo?.n === n) return dom_memo.shape;
	let shape: DomShape | null = null;
	// (one walk is ~0.9 ms on 17,000 elements: past 60,000 the count alone says enough)
	if (n >= 60_000) shape = { nodes: n, depth: 0, deepest: '', widest: { at: '', children: 0 }, islands: [] };
	else if (n >= 1500) {
		// (`ul.results`: its id, else its first own class — not the scoping class Svelte adds)
		const brief = (el: Element) => {
			let cls = '';
			for (const c of el.classList)
				if (!c.startsWith('svelte-')) {
					cls = c;
					break;
				}
			return `${el.tagName.toLowerCase()}${el.id ? `#${el.id.slice(0, 30)}` : cls ? `.${cls.slice(0, 30)}` : ''}`;
		};
		// (a walk down first children and across siblings, the depth a counter: no map of 17,000
		// elements — 0.9 ms where a Map of depths took ~15)
		let depth = 0;
		const root = document.documentElement;
		let deepest: Element = root;
		let widest: Element = root;
		let widest_n = root.childElementCount;
		let el: Element | null = root;
		let d = 1;
		while (el) {
			if (d > depth) (depth = d), (deepest = el);
			const kids = el.childElementCount;
			if (kids > widest_n) (widest_n = kids), (widest = el);
			const first: Element | null = el.firstElementChild;
			if (first) {
				el = first;
				d++;
				continue;
			}
			while (el && el !== root && !el.nextElementSibling) {
				el = el.parentElement;
				d--;
			}
			el = el && el !== root ? el.nextElementSibling : null;
		}
		const islands: { fp: string; nodes: number }[] = [];
		for (const r of document.querySelectorAll(ISLAND_SEL)) {
			const fp = r.getAttribute('data-og-fp');
			if (fp) islands.push({ fp, nodes: r.getElementsByTagName('*').length });
		}
		islands.sort((a, b) => b.nodes - a.nodes);
		shape = { nodes: n, depth, deepest: brief(deepest), widest: { at: brief(widest), children: widest_n }, islands: islands.slice(0, 3) };
	}
	dom_memo = { n, shape };
	return shape;
}

/** IMAGES THE BROWSER COULD NOT HOLD ROOM FOR: an `<img>` with a box whose computed aspect-ratio is
 *  `auto` — no width and height attributes (they make it `auto W / H`) and no CSS aspect-ratio —
 *  so the page below moved when its file arrived. A hidden one (no box, a hidden parent too) is
 *  left out. Their srcs, the first 8. */
function images_unsized(): string[] {
	const out: string[] = [];
	const imgs = document.images;
	for (let i = 0; i < imgs.length && i < 300 && out.length < 8; i++) {
		const img = imgs[i];
		if (img.hasAttribute('width') && img.hasAttribute('height')) continue;
		if (!img.getClientRects().length) continue;
		if (getComputedStyle(img).aspectRatio !== 'auto') continue;
		const src = img.currentSrc || img.src;
		if (src && !src.startsWith('data:')) out.push(src.slice(0, 300));
	}
	return out;
}

/** IMAGES FAR BELOW THE FIRST SCREEN THAT LOADED AT START: a raster `<img>` whose top sits more
 *  than a screen and a half down the document, not `loading="lazy"`, its file 20 KB or more, and
 *  fetched before the page's load ended — its bytes competed with the first screen's files. A
 *  hidden image (no box) is left out. Positions are the document's (the scroll added back). */
function images_eager_below(load_end: number): { url: string; top: number; bytes: number; fp?: string }[] {
	const out: { url: string; top: number; bytes: number; fp?: string }[] = [];
	const fold = innerHeight * 1.5;
	const imgs = document.images;
	for (let i = 0; i < imgs.length && i < 300 && out.length < 10; i++) {
		const img = imgs[i];
		if (img.loading === 'lazy') continue;
		const url = img.currentSrc || img.src;
		if (!url || url.startsWith('data:')) continue;
		const r = img.getBoundingClientRect();
		if (!r.width || !r.height) continue;
		const top = Math.round(r.top + scrollY);
		if (top < fold) continue;
		const e = performance.getEntriesByName(url, 'resource')[0] as PerformanceResourceTiming | undefined;
		if (!e || (load_end > 0 && e.startTime > load_end)) continue;
		const bytes = e.encodedBodySize || e.transferSize || 0;
		if (bytes < 20_000) continue;
		const fp = fp_of(img);
		out.push({ url: url.slice(0, 500), top, bytes, ...(fp ? { fp } : {}) });
	}
	return out;
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
	// what each <link> fetched as (a preload's `as`, a modulepreload's script): a link is not a
	// stylesheet only — the island graph's modulepreloads and the holes' fetch preloads are links too
	const link_as = new Map<string, string>();
	// (and its crossorigin: what a double download's fix turns on)
	const link_co = new Map<string, string | null>();
	try {
		for (const l of document.querySelectorAll<HTMLLinkElement>('link[href][as], link[rel="modulepreload"][href]')) {
			link_as.set(l.href, l.getAttribute('as') ?? 'script');
			link_co.set(l.href, l.getAttribute('crossorigin'));
		}
	} catch {
		/* no document */
	}
	const preload_misses: { url: string; type: string; bytes: number; as: string; crossorigin: string | null }[] = [];
	const type_of = (r: PerformanceResourceTiming): string => resource_type(ext_of(r.name), r.initiatorType, link_as.get(r.name));
	let resources: Record<string, unknown>[] = [];
	const refetched: { url: string; how: 'revalidated' | 'downloaded'; bytes: number; ms: number; entry?: string; hole?: string; runtime?: true }[] = [];
	// every file by type (the counts and bytes of ALL of them), next to the first 200 in detail
	const totals = new Map<string, { type: string; count: number; transfer: number; size: number }>();
	let all_n = 0;
	// text the server sent uncompressed, the largest first (the document itself is in `nav.raw`)
	const uncompressed: { url: string; type: string; bytes: number }[] = [];
	const raw_seen = new Set<string>();
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
			// TEXT SENT AS IT IS: a script, a stylesheet, JSON… whose body came down as large as it is
			// decoded (no gzip, no brotli). A cross-origin file without Timing-Allow-Origin reports
			// zeros and is never counted; images and fonts are compressed formats already
			if (
				r.decodedBodySize >= UNCOMPRESSED_MIN &&
				r.encodedBodySize >= r.decodedBodySize &&
				!raw_seen.has(r.name) &&
				(type === 'script' || type === 'style' || TEXT_EXT.has(ext_of(r.name)) || r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest')
			) {
				raw_seen.add(r.name);
				uncompressed.push({ url: r.name.slice(0, 500), type, bytes: r.decodedBodySize });
			}
		}
		uncompressed.sort((a, b) => b.bytes - a.bytes);
		uncompressed.length = Math.min(uncompressed.length, MAX_UNCOMPRESSED);
		// PRELOADED, THEN DOWNLOADED AGAIN: one URL fetched by a preload link and again by something
		// else, the second time over the network (its body came down, not from the cache). The
		// browser could not use the preload — its crossorigin or credentials did not match the
		// request (a font preload without `crossorigin` is the classic) — and paid for the file twice
		const by_url = new Map<string, PerformanceResourceTiming[]>();
		for (const r of all) (by_url.get(r.name) ?? by_url.set(r.name, []).get(r.name)!).push(r);
		for (const [url, list] of by_url) {
			if (list.length < 2 || preload_misses.length >= 20) continue;
			const pre = list.find((r) => r.initiatorType === 'link');
			const downloads = list.filter((r) => r !== pre && r.initiatorType !== 'link' && r.encodedBodySize > 0 && r.transferSize >= r.encodedBodySize);
			const again = downloads[0];
			// (a preload the server answered with an error: what follows is a retry, not a miss —
			// the failure is its own finding)
			if (((pre as (PerformanceResourceTiming & { responseStatus?: number }) | undefined)?.responseStatus ?? 0) >= 400) continue;
			// (the runtime asked for a hole more often than the network served it: the preload WAS
			// used, and the download is the runtime's own second ask — a hole fetched again after
			// Kit rebuilt the page, a retry)
			if (downloads.length < (hole_fetches.get(url) ?? 0)) continue;
			if (pre && again) preload_misses.push({ url: url.slice(0, 500), type: type_of(pre), bytes: again.transferSize, as: link_as.get(url) ?? '', crossorigin: link_co.get(url) ?? null });
		}
		// CONTENT-NAMED FILES FETCHED AGAIN: a file under `/immutable/` is named by its content, so a
		// browser that has it should never ask again. Revalidated (a 304: the body came from the cache
		// but the headers from the server, so the transfer is smaller than the body) means the host
		// did not let the browser keep it (its bytes are unknown then: a 304 reports no body, so the
		// cost is the round trip); downloaded in full on a reload means the same, only worse
		// (the browser had it a moment ago). A first visit's downloads say nothing, and are left out.
		// (a cross-origin file without Timing-Allow-Origin reports zeros: it is never counted)
		const reload = nav!.type === 'reload';
		const origin = location.origin;
		// each island's location → its identity, and the hole whose answer carried it (the server's
		// render of the page never saw that island, so the report names it by its hole)
		const entry_of = new Map<string, { entry: string; hole?: string }>();
		for (const el of document.querySelectorAll('ogygia-region[src][entry]')) {
			const src = el.getAttribute('src')!;
			try {
				const host = el.parentElement?.closest('ogygia-region[endpoint]');
				const hole = host ? (new URL(host.getAttribute('endpoint')!, location.href).searchParams.get('id') ?? '') : '';
				entry_of.set(new URL(src, document.baseURI).href, { entry: el.getAttribute('entry')!, ...(hole ? { hole: hole.slice(0, 40) } : {}) });
			} catch {
				/* not a URL */
			}
		}
		const runtime_src = (document.querySelector('script[data-ogygia-runtime]') as HTMLScriptElement | null)?.src ?? '';
		const counted = new Set<string>();
		for (const r of all) {
			if (refetched.length >= MAX_REFETCHED || counted.has(r.name) || !r.name.startsWith(origin) || !r.name.includes('/immutable/')) continue;
			const body = r.encodedBodySize;
			if (!(r.transferSize > 0)) continue;
			// Chrome reports a 304 as headers only (transfer ~300 B) with NO body (0: the body came from
			// the cache); a browser that reports the cached body has a transfer under it. A full download
			// has both, the transfer at least the body.
			const how = body === 0 || r.transferSize < body ? 'revalidated' : reload ? 'downloaded' : null;
			if (!how) continue;
			counted.add(r.name);
			const island = entry_of.get(r.name);
			refetched.push({
				url: r.name.slice(0, 500),
				how,
				bytes: body,
				ms: r2(r.duration),
				...(island ? { entry: island.entry.slice(0, 300), ...(island.hole ? { hole: island.hole } : {}) } : {}),
				...(r.name === runtime_src ? { runtime: true } : {})
			});
		}
		// the detail: every render-blocking file (they explain the first paint), then the earliest
		const blocking = (r: PerformanceResourceTiming) => (r as { renderBlockingStatus?: string }).renderBlockingStatus === 'blocking';
		const keep = all.filter(blocking).slice(0, MAX_DETAIL_RESOURCES);
		// …and the largest paint's own file, always (its timing splits the LCP: a late one — an image a
		// script added after a dev server's 250 modules — fell past the cut)
		const lcp_res = visit_paints.lcp_url ? all.find((r) => r.name === visit_paints.lcp_url) : undefined;
		if (lcp_res && !keep.includes(lcp_res)) keep.push(lcp_res);
		// …then everything that is not a script (the holes' answers, fetches, images, styles, fonts),
		// then the scripts, each by when it started: a dev server's hundreds of modules pushed the holes'
		// own requests past the cut (a hole's waterfall and its fetch type went missing)
		const kept = new Set(keep);
		for (const pass of [false, true])
			for (const r of all) {
				if (keep.length >= MAX_DETAIL_RESOURCES) break;
				if (kept.has(r) || (type_of(r) === 'script') !== pass) continue;
				kept.add(r);
				keep.push(r);
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
	// the @font-face rules behind the fonts it fetched (whether a late one hid its text)
	let fonts: { family: string; display: string; urls: string[] }[] = [];
	try {
		fonts = font_faces_of(new Set(resources.filter((r) => r.type === 'font').map((r) => r.url as string)));
	} catch {
		/* no stylesheets to read */
	}
	let oversized: ReturnType<typeof oversized_images> = [];
	let dom: DomShape | null = null;
	let wasted: { url: string; as: string; bytes: number }[] | null = null;
	let below: ReturnType<typeof images_eager_below> = [];
	let unsized: string[] | null = null;
	try {
		oversized = oversized_images();
		below = images_eager_below(nav.loadEventEnd);
		unsized = images_unsized();
		dom = dom_shape();
		wasted = preloads_never_used(nav.loadEventEnd);
	} catch {
		/* no document */
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
			// (the HTML came down as large as it is: sent without gzip or brotli)
			...(nav.decodedBodySize >= UNCOMPRESSED_MIN && nav.encodedBodySize >= nav.decodedBodySize ? { raw: true } : {}),
			...(nav.nextHopProtocol ? { protocol: nav.nextHopProtocol } : {}),
			// THE WAIT FOR THE FIRST BYTE, step by step: redirects, a service worker starting, the DNS
			// lookup, the connection (and its TLS), then the request until the server's first byte —
			// what TTFB is made of (only the steps that took time)
			...nav_phases(nav),
			// the document's own Server-Timing (what the server says its time went to), the first few
			...(nav.serverTiming?.length
				? { server_timing: nav.serverTiming.slice(0, 8).map((s) => ({ name: s.name.slice(0, 40), ms: r2(s.duration), ...(s.description ? { desc: s.description.slice(0, 80) } : {}) })) }
				: {})
		},
		paints: lcp_el && !lcp_el.isConnected && lcp_region?.isConnected ? { ...visit_paints, lcp_replaced: true } : visit_paints,
		resources,
		...(all_n > resources.length ? { resource_totals: [...totals.values()], resources_all: all_n } : {}),
		...(preload_misses.length ? { preload_misses } : {}),
		...(uncompressed.length ? { uncompressed } : {}),
		...(fonts.length ? { font_faces: fonts } : {}),
		...(oversized.length ? { images_oversized: oversized } : {}),
		...(dom ? { dom } : {}),
		...(wasted?.length ? { preloads_unused: wasted } : {}),
		...(below.length ? { images_eager_below: below } : {}),
		// (sent empty too: "the browser looked and found none" is what lets the profiler drop its
		// guess from the HTML)
		...(unsized ? { images_unsized: unsized } : {}),
		...(visit_forced.length ? { forced_layout: visit_forced.slice() } : {}),
		...(visit_scroll_jank.length ? { scroll_jank: visit_scroll_jank.slice() } : {}),
		...(refetched.length ? { refetched } : {}),
		...(visit_navs.length ? { navs: visit_navs.slice() } : {}),
		longtasks: visit_longtasks,
		islands: visit_islands,
		firsts: visit_firsts,
		shifts: visit_shifts,
		...(visit_interaction ? { interaction: interaction_with_scripts(visit_interaction) } : {}),
		...(visit_scripts.size ? { scripts: [...visit_scripts].map(([url, s]) => ({ url, ms: r2(s.ms), count: s.count })).sort((a, b) => b.ms - a.ms).slice(0, 50) } : {}),
		regions: visit_regions(),
		...(visit_warnings.length ? { warnings: visit_warnings.slice() } : {}),
		...(visit_holes_failed.length ? { holes_failed: visit_holes_failed.slice() } : {}),
		...(visit_holes_answered.length ? { holes_answered: visit_holes_answered.slice() } : {}),
		...(visit_hole_batches.length ? { hole_batches: visit_hole_batches.slice() } : {}),
		// a server transform's restore that went wrong (runtime/restore.ts keeps the log: it ran
		// while the page parsed)
		...restore_log(),
		...(visit_entry_fallbacks.length ? { entry_fallbacks: visit_entry_fallbacks.slice() } : {}),
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
/**
 * THE PAGE A VISIT BELONGS TO: the one the document loaded as. The visit is the document's whole
 * story — its load, its vitals, and every in-app navigation after it (the router's body swaps keep
 * the document) — so it, its vitals and its CPU traces are filed under the page the visitor landed
 * on, never under wherever the address bar is when a later message leaves: a navigation to /b then
 * filed the rest of /a's visit (the navigation itself among it) under /b, where /a's report never
 * looks. Read at boot (observe_vitals), and on first use after a reset.
 */
let landing_page: string | null = null;
function visit_page(): string {
	// (no document location — a server, a test — has no page to file under yet: read again later)
	if (landing_page === null && typeof location !== 'undefined') landing_page = location.pathname;
	return landing_page ?? '/';
}

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
				// (a windowed snapshot: the same window of the markup without comments)
				const html = s.from === undefined ? el.innerHTML : without_comments(el.innerHTML).slice(s.from, s.from + SNAPSHOT_CAP);
				if (html !== s.hydrated) s.final = html.slice(0, SNAPSHOT_CAP);
			}
		}
	}
	if (!endpoint()) return; // devtools alone: nothing leaves the page
	send(JSON.stringify({ page: visit_page(), visit }), () =>
		JSON.stringify({ page: visit_page(), visit: { ...visit, resources: [], regions: [], islands: [] } })
	);
	void store_visit({ key: `${visit_page()}|${visit.at}`, page: visit_page(), at: visit.at as number, visit, snapshots });
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
let cpu_kept: CpuKept[] = [];
/** a kept trace; an interaction's carries its spans (the wait, the handlers) */
export interface CpuKept {
	trace: unknown;
	from: number;
	to: number;
	label: string;
	spans?: { t: number; wait: [number, number]; handler: [number, number] };
}
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
/** THE IN-APP NAVIGATIONS (the router's body swaps), each on the page's clock: its start, the page
 *  fetched, its stylesheets in, the swap committed. A slow one is a cost the document's own timing
 *  never shows; the islands the new page woke are in the visit's island list, after `swapped`. */
interface NavRec {
	from: string;
	to: string;
	type: string;
	t: number;
	fetched: number;
	styled: number;
	swapped: number;
	/** the page's address as fetched: its resource timing splits the fetch */
	href?: string;
}
/** …and the fetch split, from the page request's own timing: the wait for the server's first
 *  byte, the download and its bytes; `prefetched` when the request began before the click (the
 *  router's hover prefetch: the page was already on its way) */
type NavOut = Omit<NavRec, 'href'> & { server?: number; download?: number; bytes?: number; prefetched?: true };
let visit_navs: NavOut[] = [];
export function beacon_nav(n: NavRec): void {
	const o = owner();
	// (an older owning copy has no such entry: stay quiet)
	if (o) return o.beacon_nav?.(n);
	if (!collecting() || visit_navs.length >= 20) return;
	let split: Pick<NavOut, 'server' | 'download' | 'bytes' | 'prefetched'> = {};
	try {
		// the page request: the latest fetch of that address that was done by the time it arrived
		const entries = n.href ? (performance.getEntriesByName(n.href) as PerformanceResourceTiming[]) : [];
		let e: PerformanceResourceTiming | undefined;
		for (const x of entries) if (x.initiatorType === 'fetch' && x.responseEnd <= n.fetched + 1 && (!e || x.startTime > e.startTime)) e = x;
		if (e && e.responseStart > 0) {
			const asked = e.requestStart > 0 ? e.requestStart : e.startTime;
			split = {
				server: r2(Math.max(0, e.responseStart - asked)),
				download: r2(Math.max(0, e.responseEnd - e.responseStart)),
				...(e.transferSize || e.encodedBodySize ? { bytes: e.transferSize || e.encodedBodySize } : {}),
				...(e.startTime < n.t - 1 ? { prefetched: true as const } : {})
			};
		}
	} catch {
		split = {};
	}
	if (first_nav_t === undefined) {
		first_nav_t = n.t;
		snapshot_firsts = snapshots.length;
	}
	visit_navs.push({ from: n.from.slice(0, 300), to: n.to.slice(0, 300), type: (n.type || 'link').slice(0, 20), t: r2(n.t), fetched: r2(n.fetched), styled: r2(n.styled), swapped: r2(n.swapped), ...split });
	resend_soon();
}

export function beacon_failed(el: Element, message?: string, since?: number): void {
	const o = owner();
	if (o) return o.beacon_failed(el, message, since);
	if (!collecting()) return;
	const fp = el.getAttribute('data-og-fp');
	if (!fp) return;
	failed_fps.set(fp, (message ?? '').slice(0, 300));
	// its wake → now: it was loading (and held the turns of islands below the fold) meanwhile
	if (typeof since === 'number') failed_spans.set(fp, [r2(since), r2(performance.now())]);
}
const failed_spans = new Map<string, [number, number]>();

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
				...(failed !== undefined ? { failed, ...(failed_spans.has(fp) ? { failed_span: failed_spans.get(fp) } : {}) } : {}),
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
	// the load is sampled: now wait, sampling, for a slow interaction (never while hiding)
	if (!hiding) start_interaction_cpu();
	const url = endpoint();
	if (!url || !trace) return;
	const body = JSON.stringify({ page: visit_page(), cpu: trace });
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

// A CPU PROFILE OF THE SLOWEST INTERACTION. The load trace ends once the islands woke; a click after
// that ran unsampled, and the long frames name only the entry point it ran through (Svelte sends
// every event through one dispatcher). So once the load trace is out, the same browser — the
// profiler's own, or a devtools one: the policy gates it exactly as the load trace — samples again,
// waiting for an interaction of 200 ms or more. The first one stops it a moment after its paint and
// the trace goes out with the interaction's two spans (the wait before its handlers, the handlers),
// for the server to name what ran in each. None within a minute: stopped, nothing sent.
let icpu: SelfProfiler | null = null;
let icpu_timer: ReturnType<typeof setTimeout> | null = null;
let icpu_done = false;
const ICPU_MAX_MS = 60_000;
const ICPU_SLOW_MS = 200;
/** the interaction the running sampler caught, when one did */
let icpu_caught: { t: number; wait: [number, number]; handler: [number, number] } | null = null;

function start_interaction_cpu(): void {
	if (icpu || icpu_done || !collecting()) return;
	icpu = make_profiler();
	if (!icpu) return;
	icpu_timer = setTimeout(() => void stop_interaction_cpu(false), ICPU_MAX_MS);
}

/** the event observer saw a new slowest interaction: a slow one ends the sampling shortly after */
function interaction_seen(i: Interaction): void {
	if (!icpu || icpu_caught || i.ms < ICPU_SLOW_MS) return;
	const handlers_at = i.t + i.delay;
	icpu_caught = { t: i.t, wait: [i.t, handlers_at], handler: [handlers_at, handlers_at + i.processing] };
	if (icpu_timer) clearTimeout(icpu_timer);
	// (a moment for the rest of its entries and its paint; the trace then holds all of it)
	icpu_timer = setTimeout(() => void stop_interaction_cpu(false), 300);
}

async function stop_interaction_cpu(hiding: boolean): Promise<void> {
	if (!icpu) return;
	const p = icpu;
	icpu = null;
	icpu_done = true;
	if (icpu_timer) clearTimeout(icpu_timer);
	icpu_timer = null;
	let trace: unknown;
	try {
		trace = await p.stop();
	} catch {
		return;
	}
	let caught = icpu_caught;
	if (!trace || !caught) return;
	// (entries of the same interaction that arrived after it was caught widen its spans)
	const i = visit_interaction;
	if (i && i.t === caught.t) {
		const handlers_at = i.t + i.delay;
		caught = { t: i.t, wait: [i.t, handlers_at], handler: [handlers_at, handlers_at + i.processing] };
	}
	if (DEVTOOLS) cpu_kept = [{ trace, from: caught.wait[0], to: caught.handler[1], label: 'interaction', spans: caught }, ...cpu_kept.slice(0, 4)];
	const url = endpoint();
	if (!url) return;
	const body = JSON.stringify({ page: visit_page(), cpu: trace, interaction: caught });
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

/** when the document's first in-app navigation started (its first page's record ends there) */
let first_nav_t: number | undefined;
/**
 * Room in a capped list of the visit. Full: the oldest entry from AFTER the document's first in-app
 * navigation goes — the page in view keeps its record (a long session of navigations filled the
 * lists with the pages before it: one 320-island page left every later page with no islands at all,
 * and the Page tab found nothing there), and the page the document loaded as keeps all of its own
 * (the profiler's report is about that one). `false`: full of the first page's, the new one waits.
 */
/** how many snapshots the first page took (a snapshot has no time of its own) */
let snapshot_firsts = 0;
function snapshot_room(): boolean {
	if (snapshots.length < MAX_SNAPSHOTS) return true;
	if (first_nav_t === undefined || snapshots.length <= snapshot_firsts) return false;
	snapshots.splice(snapshot_firsts, 1);
	return true;
}
function make_room<T>(list: T[], cap: number, t_of: (x: T) => number): boolean {
	if (list.length < cap) return true;
	if (first_nav_t === undefined) return false;
	const from = first_nav_t;
	const i = list.findIndex((x) => t_of(x) >= from);
	if (i === -1) return false;
	list.splice(i, 1);
	return true;
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
// (a tab closed hard, a browser that drops beacons while unloading). So do a later largest paint,
// a shift, a hole's answer or failure, an island waking late. At most RESEND_MAX times a page: a
// page that keeps shifting would otherwise send its visit every couple of seconds for ever.
let resend_timer: ReturnType<typeof setTimeout> | null = null;
let resends = 0;
const RESEND_MAX = 8;
function resend_soon(): void {
	if (!endpoint() || visit_sent || resends >= RESEND_MAX) return;
	if (resend_timer) clearTimeout(resend_timer);
	resend_timer = setTimeout(() => {
		resend_timer = null;
		resends++;
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
		send_after_preload_check();
	}
}

/** A page with image, font or stylesheet preloads: the visit once more after the 3 s past load
 *  that tells a preload nothing used — a visitor who leaves without the page hiding cleanly (a
 *  closed tab, a crash) would otherwise never send it. resend_soon waits 1.5 s itself. */
function send_after_preload_check(): void {
	try {
		if (!document.querySelector('link[rel="preload"][as="image"]:not([imagesrcset]), link[rel="preload"][as="font"], link[rel="preload"][as="style"]')) return;
		if (document.readyState === 'complete') {
			const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
			setTimeout(resend_soon, Math.max(0, 1700 - (performance.now() - (nav?.loadEventEnd ?? 0))));
		} else addEventListener('load', () => setTimeout(resend_soon, 1700), { once: true });
	} catch {
		/* no document */
	}
}

/** the page is going away: the islands still queued, then the vitals (final only now), the visit */
function on_hide(): void {
	flush();
	flush_vitals();
	flush_visit(true);
	void flush_cpu(true);
	void stop_interaction_cpu(true);
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
	const sent = endpoint()
		? {
				fp,
				entry: el.getAttribute('entry') ?? '',
				ms: Math.max(0, r2(t_done - t0)),
				load: Math.max(0, r2(t_loaded - t0)),
				...(recovered ? { recovered: true } : {}),
				...(reason ? { reason } : {})
			}
		: null;
	if (sent) queue.push(sent);
	let changed: boolean | undefined;
	const room = make_room(visit_islands, 400, (i) => i.t0);
	if (typeof ssr_html === 'string' && room) {
		const now = el.innerHTML;
		// compared without comments: hydration re-anchors Svelte's block markers (`<!--[-->`), which
		// nobody sees — only a change a visitor could see counts
		if (now !== ssr_html) {
			const a = without_comments(ssr_html);
			const b = without_comments(now);
			changed = a !== b;
			if (changed && snapshot_room()) snapshots.push(snapshot_of(fp, ssr_html, now, a, b));
		} else changed = false;
	}
	// the early visit can leave before any island wakes (the boot schedules it; a page whose scripts
	// block the wake idles first): an island waking after it re-sends the visit (debounced), rather
	// than leaving the islands to the hide-time message, the one most often lost
	if (early_visit_done) resend_soon();
	const rec: VisitIslandRec | null = room
		? {
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
			}
		: null;
	if (rec) visit_islands.push(rec);
	// ITS EFFECTS: Svelte's `hydrate()` leaves `$effect`s (and onMount) to a microtask it queued
	// during the call, so they run after `done` — a heavy one (a measure, a subscription) was nobody's
	// time. A microtask queued now runs after that flush: when the island's own work really ended
	if (rec || sent)
		queueMicrotask(() => {
			const fx = performance.now();
			if (fx - t_done < 1) return;
			if (rec) rec.fx = r2(fx);
			if (sent) sent.ms = Math.max(0, r2(fx - t0));
		});
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
	snapshots: Snapshot[];
	/** the main thread, sampled (JS Self-Profiling): the load trace and recordings, newest first */
	cpu: { state: 'recording' | 'done' | 'off'; off?: string | null; traces: CpuKept[] };
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
	icpu = null;
	if (icpu_timer) clearTimeout(icpu_timer);
	icpu_timer = null;
	icpu_done = false;
	icpu_caught = null;
	opted = undefined;
	failed_fps.clear();
	failed_spans.clear();
	visit_navs = [];
	first_nav_t = undefined;
	snapshot_firsts = 0;
	landing_page = null;
	seen_resources = [];
	faces_memo = null;
	dom_memo = null;
	preloads_memo = null;
	visit_islands = [];
	visit_firsts = [];
	visit_shifts = [];
	visit_longtasks = [];
	visit_scripts = new Map();
	visit_forced = [];
	visit_scroll_jank = [];
	scroll_times = [];
	visit_interaction = null;
	visit_interaction_id = 0;
	visit_interaction_span = null;
	visit_frames = [];
	visit_warnings = [];
	visit_holes_failed = [];
	visit_holes_answered = [];
	visit_hole_batches = [];
	visit_entry_fallbacks = [];
	holes_answered_els = new WeakSet();
	hole_fetches = new Map();
	visit_marks = [];
	visit_paints = {};
	lcp_el = lcp_region = null;
	snapshots = [];
	visit_sent = false;
	early_visit_done = false;
	resends = 0;
}

/** @internal tests */
export function _beacon_state(): { target: string | null | undefined; queued: number; marks: number; scheduled: boolean; snapshots: number } {
	return { target, queued: queue.length, marks: marks.length, scheduled, snapshots: snapshots.length };
}

/** @internal tests: the size-aware send */
export const _beacon_send = send;
