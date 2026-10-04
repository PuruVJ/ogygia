/**
 * The Page tab's DOM side: reads the regions off the page and the failures off the bus, hands them
 * with the beacon's visit to the pure {@link ./page-insights.js analyzer}. Also publishes
 * `window.__ogygia_page()` (dev-only, devtools builds) so the planted-problem answer key and e2e
 * read the same report the tab shows without opening the panel.
 */
import { beacon_page, hole_request_times, is_headless } from '../runtime/beacon.js';
import { tool_fetch } from '../tool-fetches.js';
import { snapshot } from './bus.js';
import { page_ledger } from './ledger-dom.js';
import { all_regions, region_name, region_names, region_props_sidecar, region_transitive } from './regions.js';
import { compare as fp_compare, type FpDrift, type KeptIsland } from './fp-drift.js';
import { leftover_state, owned_leftovers, owned_scroll_listeners, scroll_listeners, unload_listeners } from './leftovers.js';

const FPS_KEY = 'ogygia:devtools:fps';
/** props text kept per island (a longer one is compared by its fingerprint alone) */
const FPS_PROPS_CAP = 8000;
/** pages kept per tab */
const FPS_PAGES_CAP = 20;
let fps_memo: { at: string; drift: FpDrift[] } | null = null;

/** This page load's islands against this tab's last load of the same page (fp-drift.ts): once per
 *  load — the first call records this load for the next one. `nav` — the in-app navigation it follows. */
function fp_drift(nav = 0): FpDrift[] {
	const page = location.pathname + location.search;
	const at = `${performance.timeOrigin}:${nav}:${page}`;
	if (fps_memo?.at === at) return fps_memo.drift;
	const now: KeptIsland[] = [];
	for (const r of all_regions()) {
		if (r.kind !== 'island' || !r.entry || !r.fp || r.rides) continue;
		const text = region_props_sidecar(r.el);
		now.push({ entry: r.entry, fp: r.fp, ...(text !== null && text.length <= FPS_PROPS_CAP ? { props: text } : {}) });
	}
	let store: Record<string, KeptIsland[]> = {};
	try {
		store = JSON.parse(sessionStorage.getItem(FPS_KEY) ?? '{}') as Record<string, KeptIsland[]>;
	} catch {
		store = {};
	}
	const drift = fp_compare(store[page] ?? [], now);
	store[page] = now;
	const pages = Object.keys(store);
	for (let i = 0; i < pages.length - FPS_PAGES_CAP; i++) delete store[pages[i]];
	try {
		sessionStorage.setItem(FPS_KEY, JSON.stringify(store));
	} catch {
		/* full or blocked: the next load just compares nothing */
	}
	fps_memo = { at, drift };
	return drift;
}
import { analyze_page, browser_of, defer_keys, prebundled_names, dev_compile_ms, vital_parts, type HeldOpen, type PartedVital, type VitalPart, type Failure, type HoleBatch, type HoleFailure, type RestoreEvent, type HoleWait, type InteractionCpuInput, type IslandCode, type PageInput, type PageReport, type RegionFact, type ServerProfileBrief } from './page-insights.js';
import { profile_for } from './profile-store.js';
import type { BeaconPage } from '../runtime/beacon.js';
import { analyze_cpu, is_trace, type CpuSummary } from './cpu.js';
import { with_source_lines } from './source-lines.js';
import { since_load, type LoadSnapshot, type SinceLoad } from './since-load.js';
import { PAGE_DEFER_KEY, PAGE_DEFER_REGISTRY_KEY } from '../page-defer.js';
import { PAGE_SEED_SELECTOR } from '../runtime/seeds.js';

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
	/** the split vitals' parts (the document's own load only): what the next load's "since" compares */
	parts?: Partial<Record<PartedVital, VitalPart[]>>;
	/** after an in-app navigation: islands the router KEPT from the page before (the same island with
	 *  the same props on both pages — still awake, no code, no hydrate). Without them, a page whose
	 *  islands were all reused read as "nothing woke" */
	kept?: { fp: string; name: string }[];
	/** each hole's first answer since the page (or the navigation): its wait, split where the
	 *  browser and the server timed it — the Page tab's hole waterfall */
	holes?: HoleWait[];
	/** holes whose answer never came (the waterfall's red rows) */
	holes_failed?: HoleFailure[];
}

export function region_facts(): RegionFact[] {
	const sy = typeof scrollY === 'number' ? scrollY : 0;
	const out: RegionFact[] = [];
	// each island's own bytes (a build's graph × the browser's sizes: what only it loads)
	const own = new Map<string, number>();
	for (const row of page_ledger()?.rows ?? []) if (row.unique > 0) own.set(row.entry, row.unique);
	const abs = (e: string | null | undefined) => {
		try {
			return e ? new URL(e, location.href).href : '';
		} catch {
			return '';
		}
	};
	for (const r of all_regions()) {
		if (!r.fp) continue;
		const box = r.el.getBoundingClientRect();
		const own_bytes = own.size && r.kind === 'island' ? own.get(abs(r.entry)) : undefined;
		// DRAWS NOTHING ON THIS SCREEN: no box of its own nor a child's (its CSS hides it here, or it is
		// empty) — then its top is no place on the page, and the screen sizes that show it are the news
		const hidden = r.kind === 'island' && !box.height && !box.width && !has_child_box(r.el);
		// (one that never draws — only `hidden` markers — is there for its effects: no screen shows it)
		const headless = hidden && is_headless(r.el);
		let shows_at: string | null = null;
		if (hidden && !headless && EAGER_WAKES.has(r.wake)) {
			// (read once per island while the page's sheets stay the same: the tab asks every tick)
			const key = `${r.fp}:${document.styleSheets.length}`;
			const seen = media_seen.get(key);
			shows_at = seen !== undefined ? seen : shown_under_media(r.el);
			if (seen === undefined) media_seen.set(key, shows_at);
		}
		out.push({
			fp: r.fp,
			name: region_name(r.entry),
			kind: r.kind,
			wake: r.wake,
			hydrated: r.hydrated,
			...(own_bytes ? { own_bytes } : {}),
			// (a zero box is a display:contents host: its first child places it)
			top: Math.round((box.height || box.width ? box.top : first_child_top(r.el)) + sy),
			height: Math.round(box.height),
			...(hidden ? { hidden: true as const } : {}),
			...(headless ? { headless: true as const } : {}),
			...(shows_at ? { shows_at } : {})
		});
	}
	return out;
}

const EAGER_WAKES = new Set(['load', 'idle']);
const media_seen = new Map<string, string | null>();

function has_child_box(el: Element): boolean {
	for (const c of el.children) {
		const b = c.getBoundingClientRect();
		if (b.height || b.width) return true;
	}
	return false;
}

/** The media query under which the page's CSS shows this hidden island (or a child of it): a rule
 *  inside an `@media` this screen does not match giving it a `display` other than `none` — or, the
 *  other way round, one inside an `@media` this screen matches hiding it (shown where that query is
 *  not: `not all and …`). The element read is what is hidden: the island's own child, or the
 *  nearest hidden wrapper around it (a sidebar island inside an aside a phone hides). Null when no
 *  readable sheet says (a cross-origin sheet, a hide by script, an empty island). */
function shown_under_media(el: Element): string | null {
	const none = (e: Element) => getComputedStyle(e).display === 'none';
	let hider: Element | null = null;
	for (const c of el.children)
		if (none(c)) {
			hider = c;
			break;
		}
	for (let up: Element | null = el; !hider && up && up !== document.body; up = up.parentElement) if (none(up)) hider = up;
	if (!hider) return null;
	const target = hider;
	const matches = (sel: string) => {
		try {
			return target.matches(sel);
		} catch {
			return false; // a selector this browser cannot match
		}
	};
	let budget = 20000;
	let hidden_by = null as string | null;
	// `off`: inside a query this screen does not match; `on`: one it matches
	const walk = (rules: CSSRuleList, off: string | null, on: string | null): string | null => {
		for (const rule of rules) {
			if (--budget < 0) return null;
			if (rule instanceof CSSMediaRule) {
				const q = rule.conditionText || rule.media.mediaText;
				const now = typeof matchMedia === 'function' && matchMedia(q).matches;
				const hit = walk(rule.cssRules, now ? off : q, now ? q : on);
				if (hit) return hit;
			} else if (rule instanceof CSSStyleRule) {
				const d = rule.style.display;
				if (!d || (!off && !on) || !matches(rule.selectorText)) continue;
				if (off && d !== 'none') return off;
				if (on && !off && d === 'none' && !hidden_by) hidden_by = on;
			} else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) {
				// (@layer, @supports, @container: their rules keep the media they sit in)
				const hit = walk((rule as CSSGroupingRule).cssRules, off, on);
				if (hit) return hit;
			}
		}
		return null;
	};
	for (const sheet of document.styleSheets) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue; // cross-origin: unreadable
		}
		const hit = walk(rules, null, null);
		if (hit) return hit;
	}
	const by = hidden_by as string | null;
	return by ? (by.startsWith('(') ? `not all and ${by}` : `not ${by}`) : null;
}

/** THE DEV SERVER'S PRE-BUNDLED PACKAGES, read once from its `.vite/deps/_metadata.json` (the folder of
 *  a pre-bundled script the page loaded — no guess at the app's base): the names its `optimized` keys
 *  belong to. Null until read; never off the dev server, nor on a page that loaded no pre-bundled file. */
let prebundled: string[] | null = null;
let prebundled_asked = false;
function prebundled_packages(script_urls: readonly string[]): string[] | null {
	if (!import.meta.env.DEV || prebundled_asked) return prebundled;
	const one = script_urls.find((u) => u.includes('/node_modules/.vite/deps/'));
	if (!one) return null;
	prebundled_asked = true;
	const dir = one.slice(0, one.indexOf('/node_modules/.vite/deps/') + 25);
	void tool_fetch(dir + '_metadata.json')
		.then((r) => (r.ok ? r.json() : null))
		.then((m: { optimized?: Record<string, unknown> } | null) => {
			prebundled = prebundled_names(Object.keys(m?.optimized ?? {}));
		})
		.catch(() => {});
	return null;
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
			// its wake (the start event before it): the span it was loading, holding the others' turns
			let start: number | undefined;
			for (let j = i - 1; j >= 0 && e.fp; j--) {
				const s = ev[j];
				if (s.name === 'region.hydrate.start' && s.fp === e.fp) {
					start = s.t;
					break;
				}
			}
			out.push({ fp: e.fp, message: e.message, ...(start !== undefined ? { span: [start, e.t] as [number, number] } : {}) });
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
		if (!t?.top?.length && !t?.barrels?.length && !t?.hazards?.length) continue;
		out.push({ fp: r.fp ?? undefined, name: region_name(r.entry), bytes: t.bytes, top: t.top ?? [], barrels: t.barrels ?? [], ...(t.hazards?.length ? { hazards: t.hazards } : {}) });
	}
	return out;
}

/** How long each hole's fallback showed before its first answer (since the last navigation), and
 *  whether it sits on the first screen. */
export function hole_waits(since = last_nav()?.t ?? -Infinity, fcp = 0): HoleWait[] {
	const out: HoleWait[] = [];
	const seen = new Set<string>();
	const batched = batch_parts(since);
	for (const e of snapshot()) {
		if (e.name !== 'region.server.applied' || e.wait_ms === undefined || e.t < since) continue;
		const key = e.endpoint ?? e.entry ?? '';
		if (seen.has(key)) continue;
		seen.add(key);
		const el = e.endpoint ? document.querySelector(`ogygia-region[endpoint="${CSS.escape(e.endpoint)}"]`) : null;
		let id = '';
		try {
			id = e.endpoint ? (new URL(e.endpoint, location.href).searchParams.get('id') ?? '') : '';
		} catch {
			id = '';
		}
		const rect = el?.getBoundingClientRect();
		// how long the visitor SAW the fallback: from the first paint (or the hole's own start, when
		// later: one woken by a scroll) to the swap. The fetch step alone undercounts: a prefetch may
		// have started the request earlier, and the fallback was on screen since the paint anyway
		const start = Math.max(fcp, since, e.t - e.wait_ms);
		// its request as the browser timed it: splits the wait into before it left, and the server. A
		// batched hole has no request of its own: the batch's start, and its own part's landing
		const part = e.endpoint ? batched.get(e.endpoint) : undefined;
		const times = part ? { left: part.left, first: part.at, end: part.at } : e.endpoint ? hole_request_times(e.endpoint, e.t) : null;
		out.push({
			name: (id && region_names()[id]) || (e.entry ? region_name(e.entry) : 'a hole'),
			wait_ms: Math.max(0, Math.round(e.t - start)),
			below_fold: !!rect && rect.top + scrollY > innerHeight,
			...(e.endpoint ? { endpoint: e.endpoint } : {}),
			shown_at: Math.round(start),
			...(times ? { left_at: times.left, first_at: times.first, end_at: times.end } : {}),
			...(times && 'render' in times && times.render !== undefined ? { server_ms: times.render } : {}),
			...(times && 'queue' in times && times.queue !== undefined ? { server_queue_ms: times.queue } : {}),
			...(part ? { batch_size: part.size } : {})
		});
	}
	return out;
}

/** Each hole a batch request carried (since `since`): endpoint → the batch's start (the browser's
 *  timing of the POST, else the send), its own part's landing, and the batch's size. */
function batch_parts(since: number): Map<string, { left: number; at: number; size: number }> {
	const out = new Map<string, { left: number; at: number; size: number }>();
	const sent = new Map<number, { t: number; size: number; left?: number }>();
	for (const e of snapshot()) {
		if (e.t < since) continue;
		if (e.name === 'region.batch.sent') sent.set(e.batch, { t: e.t, size: e.endpoints.length });
		else if (e.name === 'region.batch.part') {
			const b = sent.get(e.batch);
			if (!b) continue;
			b.left ??= batch_request_start(e.endpoint, b.t);
			out.set(e.endpoint, { left: Math.round(b.left), at: Math.round(e.t), size: b.size });
		}
	}
	return out;
}

/** When the browser sent the batch POST that left at about `sent` (its Resource Timing), or `sent`. */
function batch_request_start(endpoint: string, sent: number): number {
	try {
		const u = new URL(endpoint, location.href);
		let best: PerformanceResourceTiming | undefined;
		for (const r of performance.getEntriesByName(u.origin + u.pathname, 'resource') as PerformanceResourceTiming[])
			if (r.startTime >= sent - 5 && (!best || r.startTime < best.startTime)) best = r;
		if (best) return best.requestStart || best.startTime;
	} catch {
		/* no Resource Timing */
	}
	return sent;
}

/** Batch requests that carried fewer holes than they were sent for (since `since`). */
export function hole_batches(since = last_nav()?.t ?? -Infinity): HoleBatch[] {
	const out: HoleBatch[] = [];
	const sent = new Map<number, string[]>();
	for (const e of snapshot()) {
		if (e.t < since) continue;
		if (e.name === 'region.batch.sent') sent.set(e.batch, e.endpoints);
		else if (e.name === 'region.batch.done' && e.delivered < e.sent) {
			const names = (sent.get(e.batch) ?? []).map((ep) => {
				let id = '';
				try {
					id = new URL(ep, location.href).searchParams.get('id') ?? '';
				} catch {
					id = '';
				}
				return (id && region_names()[id]) || 'a hole';
			});
			out.push({ sent: e.sent, delivered: e.delivered, status: e.status, ...(e.refused ? { refused: e.refused } : {}), ...(e.final_url ? { final_url: e.final_url } : {}), names });
		}
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
	// (to the end of each island's effects: Svelte runs them right after `hydrate()`)
	const windows = page.islands.map((i) => ({ fp: i.fp, from: i.turn ?? i.loaded, to: Math.max(i.done, i.fx ?? 0) }));
	const out = analyze_cpu(trace, windows, page.longtasks, location.href);
	cpu_memo.set(trace, { n, out });
	return out;
}

/** The last in-app navigation (the router's body swap): where to, and when it started. */
/** This document's streamed promises, each by its `page.data` key (the seed) and when its resolve
 *  arrived (the inline bootstrap's stamp): what held the document open. Null: nothing streamed. */
export function held_open(): HeldOpen | null {
	const reg = (globalThis as unknown as Record<symbol, { t?: Record<number, number> } | undefined>)[PAGE_DEFER_REGISTRY_KEY];
	const t = reg?.t;
	if (!t) return null;
	const names = defer_keys(document.querySelector(PAGE_SEED_SELECTOR)?.textContent ?? '', PAGE_DEFER_KEY);
	const keys = Object.entries(t).map(([id, at]) => ({ key: names.get(Number(id)) ?? null, at: Math.round(at) }));
	return keys.length ? { side: 'browser', keys: keys.sort((a, b) => a.at - b.at) } : null;
}

export function last_nav(): { to: string; t: number } | null {
	const ev = snapshot();
	let own: { to: string; t: number } | null = null;
	for (let i = ev.length - 1; i >= 0; i--) {
		const e = ev[i];
		if (e.name === 'nav.start' && e.realm === 'client') {
			own = { to: e.to, t: e.t };
			break;
		}
	}
	// a page change ogygia's router did not make (SvelteKit's own client router on a Kit-hydrated
	// document): the URL moved to another page after the router's last navigation, or with none
	const moved = url_moves.at(-1);
	if (moved && (!own || (moved.t > own.t && moved.to.split('?')[0] !== own.to.split('?')[0]))) return moved;
	return own;
}

/** each change of the page's path, as the dock saw it (history.pushState, a back or forward) */
const url_moves: { to: string; t: number }[] = [];
let watching_url = false;
function watch_url(): void {
	if (watching_url || typeof history === 'undefined') return;
	watching_url = true;
	let path = location.pathname;
	const seen = () => {
		if (location.pathname === path) return;
		path = location.pathname;
		url_moves.push({ to: location.pathname + location.search, t: performance.now() });
		if (url_moves.length > 20) url_moves.shift();
	};
	const push = history.pushState;
	history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
		push.apply(this, args);
		seen();
	};
	addEventListener('popstate', seen);
}

/**
 * After an in-app navigation the beacon's visit keeps the whole document's story on one clock: the
 * first page's islands, shifts and long tasks, then this page's. The tab is about THIS page, so its
 * events are cut to those since the navigation and shifted to start there; the paints and the
 * vitals stay the document's (a soft navigation paints nothing new the browser reports).
 */
export function since_nav(page: BeaconPage, t: number): PageInput {
	const shift = <T extends { t: number }>(xs: T[]) => xs.filter((x) => x.t >= t).map((x) => ({ ...x, t: x.t - t }));
	const visit = page.visit as PageInput['visit'] | null;
	const interaction = visit?.interaction && visit.interaction.t >= t ? { ...visit.interaction, t: visit.interaction.t - t } : undefined;
	return {
		// (the vitals are the first page's: no finding about this page may lean on them)
		vitals: {},
		visit: visit
			? {
					...visit,
					paints: {},
					nav: {},
					resources: [],
					preload_misses: [],
					// (the document's preloads: the first page's)
					preloads_unused: [],
					// (the files the document fetched: the first page's)
					uncompressed: [],
					// (the document's fonts: a navigation's are the page before's too)
					font_faces: [],
					refetched: [],
					// (each script's main-thread time is the whole document's: no part of it is this page's alone)
					scripts: [],
					// Svelte's warnings while this page's islands hydrated, not the pages' before
					warnings: (visit.warnings ?? []).filter((w) => (w.t ?? 0) >= t),
					// the slowest interaction, when it happened on this page
					interaction,
					// the forced layouts of this page's time, on its clock like the islands
					forced_layout: (visit.forced_layout ?? []).filter((f) => f.start >= t).map((f) => ({ ...f, start: f.start - t, end: f.end - t })),
					scroll_jank: (visit.scroll_jank ?? []).filter((j) => j.start >= t).map((j) => ({ ...j, start: j.start - t })),
					// (this page's navigation, on its clock like the islands: the one that brought it here)
					navs: ((page.visit as PageInput['visit'])?.navs ?? []).filter((n) => n.t >= t - 1).map((n) => ({ ...n, t: n.t - t, fetched: n.fetched - t, styled: n.styled - t, swapped: n.swapped - t }))
				}
			: null,
		islands: page.islands.filter((i) => i.t0 >= t).map((i) => ({ ...i, t0: i.t0 - t, loaded: i.loaded - t, done: i.done - t, ...(i.turn !== undefined ? { turn: i.turn - t } : {}), ...(i.fx !== undefined ? { fx: i.fx - t } : {}) })),
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

/** Other origins' URLs an element of the live document names (script src, link href, in the head
 *  and body alike): the third-party scripts no element names came by an import or a fetch. */
function other_origin_refs(): string[] {
	const out = new Set<string>();
	for (const el of document.querySelectorAll('script[src],link[href]')) {
		const url = (el as HTMLScriptElement).src || (el as HTMLLinkElement).href;
		if (url && !url.startsWith(location.origin + '/')) out.add(url);
	}
	return [...out];
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

/** The slowest interaction's trace (taken after the load, kept in the page), read over its two
 *  spans — the same cut the profiler makes on its copy. Memoized per trace. */
const icpu_memo = new WeakMap<object, InteractionCpuInput>();
function interaction_cpu_of(page: BeaconPage): InteractionCpuInput | null {
	// its own trace, or — a slow interaction during the load, before that sampler started — the
	// load trace, which holds it
	let kept = page.cpu.traces.find((t) => t.label === 'interaction' && t.spans);
	if (!kept) {
		const i = page.visit?.interaction as { t: number; ms: number; delay: number; processing: number } | undefined;
		const load = page.cpu.traces.find((t) => t.label === 'page load');
		if (!i || i.ms < 200 || !load || i.t < load.from || i.t + i.ms > load.to) return null;
		const at = i.t + i.delay;
		kept = { ...load, spans: { t: i.t, wait: [i.t, at], handler: [at, at + i.processing] } };
	}
	if (!kept.spans || !is_trace(kept.trace)) return null;
	const hit = icpu_memo.get(kept.trace as object);
	if (hit && hit.t === kept.spans.t) return interaction_lines(hit);
	const { t, wait, handler } = kept.spans;
	const MIN = 20;
	const windows = [
		...(wait[1] - wait[0] >= MIN ? [{ fp: 'wait', from: wait[0], to: wait[1] }] : []),
		...(handler[1] - handler[0] >= MIN ? [{ fp: 'handler', from: handler[0], to: handler[1] }] : [])
	];
	const s = analyze_cpu(kept.trace, windows, [], location.href);
	const out: InteractionCpuInput = { t, wait: s.islands.wait ?? null, handler: s.islands.handler ?? null };
	icpu_memo.set(kept.trace as object, out);
	return interaction_lines(out);
}

/** the interaction's functions with the source's lines (a served line is not the source's): read
 *  from the files' inline maps; `mapped` once every app function has its line */
function interaction_lines(i: InteractionCpuInput): InteractionCpuInput {
	const w = i.wait ? with_source_lines(i.wait.top) : null;
	const h = i.handler ? with_source_lines(i.handler.top) : null;
	return {
		...i,
		mapped: (w?.mapped ?? true) && (h?.mapped ?? true),
		wait: i.wait && w ? { ...i.wait, top: w.fns } : null,
		handler: i.handler && h ? { ...i.handler, top: h.fns } : null
	};
}

/** the load's CPU with the source's lines, in every list the tabs and findings quote */
export function summary_lines(s: CpuSummary | null): CpuSummary | null {
	if (!s) return s;
	const islands: CpuSummary['islands'] = {};
	for (const [fp, v] of Object.entries(s.islands)) islands[fp] = { ...v, top: with_source_lines(v.top).fns };
	return { ...s, fns: with_source_lines(s.fns).fns, islands, outside: { ...s.outside, top: with_source_lines(s.outside.top).fns } };
}

/** THE PROFILER'S LAST RUN OF A PAGE, in brief: from the dock's profile store (the Profiler tab's
 *  runs, shared data — never the report re-fetched), for the Page tab's server-side sentences. */
function server_brief(path: string): ServerProfileBrief | undefined {
	const p = profile_for(path);
	if (!p) return undefined;
	// its word on where the TIME went (the Page tab asks about a wait): the first of these it raised
	const TIME_CODES = ['mostly-waiting', 'phases', 'top-component', 'top-cpu'];
	let said: string | undefined;
	for (const code of TIME_CODES) {
		said = p.findings.find((f) => f.code === code)?.message;
		if (said) break;
	}
	// (its own words, without their closing period: the sentence around it adds one)
	const trim = (m: string) => {
		const s = m.length > 200 ? m.slice(0, 200) + '…' : m;
		return s.endsWith('.') ? s.slice(0, -1) : s;
	};
	const comp = [...p.components].sort((a, b) => b.self_ms - a.self_ms)[0];
	// (the page's own Cache-Control, which only the server side sees: no-store keeps it out of the
	// back/forward cache)
	const no_store = p.cache_control && p.cache_control.toLowerCase().split(',').some((d) => d.trim() === 'no-store') ? p.cache_control : undefined;
	return {
		ago_min: Math.max(0, (Date.now() - p.at) / 60_000),
		render_ms: p.render_ms,
		top: said ? trim(said) : comp ? `${comp.name} (${Math.round(comp.self_ms)} ms of its own)` : null,
		calls: p.network?.count ?? 0,
		calls_ms: p.network?.total_ms ?? 0,
		...(no_store ? { no_store } : {}),
		...(p.prerendered ? { prerendered: p.prerendered } : {})
	};
}

/** The island a script file belongs to, when it is one's own file (by its location or identity). */
/** When this document came from Back or Forward and was NOT restored from the back/forward cache,
 *  the browser's reasons (`notRestoredReasons`, where it gives them), the first 6. */
function not_restored_reasons(): string[] {
	try {
		const n = performance.getEntriesByType('navigation')[0] as (PerformanceNavigationTiming & { notRestoredReasons?: { reasons?: { reason?: string }[] | null } | null }) | undefined;
		if (!n || n.type !== 'back_forward') return [];
		return (n.notRestoredReasons?.reasons ?? []).map((r) => String(r?.reason ?? '')).filter(Boolean).slice(0, 6);
	} catch {
		return [];
	}
}

function island_of_file(url: string): { island?: string } {
	const base = (u: string) => {
		const q = u.indexOf('?');
		const p = q === -1 ? u : u.slice(0, q);
		return p.slice(p.lastIndexOf('/') + 1);
	};
	const file = base(url);
	if (!file) return {};
	for (const r of all_regions()) {
		const src = r.el.getAttribute('src');
		if (r.entry && ((src && base(src) === file) || base(r.entry) === file)) return { island: region_name(r.entry) };
	}
	// (the dev server serves the component's own `.svelte` file, and an island's entry there is a
	// virtual id: by the component's name, as the island is named)
	if (file.endsWith('.svelte')) {
		const stem = file.slice(0, -'.svelte'.length);
		for (const r of all_regions()) if (r.kind === 'island' && r.entry && region_name(r.entry) === stem) return { island: stem };
	}
	return {};
}

export function read_page(): PageView | null {
	const page = beacon_page();
	if (!page) return null;
	const regions = region_facts();
	const nav = last_nav();
	const load = page.cpu.traces.find((t) => t.label === 'page load');
	// (the load trace belongs to the first page: after a navigation, only a new recording is this page's)
	const cpu = load && !nav ? summary_lines(cpu_of(page, load.trace)) : null;
	const base = nav ? since_nav(page, nav.t) : (page as unknown as PageInput);
	// third parties: every origin but this one (what the server's HTML named is not known here — the
	// live page already holds the script elements other scripts added — so parse time decides for a
	// script an element names, and a script no element names came by an import or a fetch)
	const in_page = other_origin_refs();
	// (an island whose own file was gone, named as every tab names it)
	const fallbacks = base.visit?.entry_fallbacks?.map((f) => ({ ...f, name: region_name(f.entry) }));
	const refetched = base.visit?.refetched?.map((f) => (f.entry ? { ...f, name: region_name(f.entry) } : f));
	// the slowest interaction's scripts, named by the island whose file each is (its location, or its
	// identity) — a built chunk name tells the reader nothing
	const interaction = base.visit?.interaction ? { ...base.visit.interaction, scripts: base.visit.interaction.scripts?.map((s) => ({ ...s, ...island_of_file(s.url) })) } : undefined;
	// …and the scripts the page's scroll waited on, the same way (a build's handler is a minified name)
	const scroll_jank = base.visit?.scroll_jank?.map((j) => ({ ...j, scripts: j.scripts.map((s) => ({ ...s, ...island_of_file(s.url) })) }));
	const with_visit: PageInput = base.visit
		? { ...base, visit: { ...base.visit, origin: location.origin, in_page, ...(fallbacks ? { entry_fallbacks: fallbacks } : {}), ...(refetched ? { refetched } : {}), ...(interaction ? { interaction } : {}), ...(scroll_jank ? { scroll_jank } : {}) } }
		: base;
	const holes = hole_failures();
	const code = island_code();
	// (after a navigation there is no new first paint: the navigation's start stands in for it)
	const waits = hole_waits(nav?.t ?? -Infinity, nav ? 0 : (with_visit.visit?.paints?.fcp ?? 0));
	const batches = hole_batches(nav?.t ?? -Infinity);
	// (the restorer ran while the page parsed, before this dock: its log, since the last navigation)
	const restores = ((window as { __og_restore_log?: RestoreEvent[] }).__og_restore_log ?? []).filter((e) => e.t >= (nav?.t ?? -Infinity));
	// (against this tab's last load of the same page; an in-app navigation counts as a load of its page)
	const drift = fp_drift(nav ? Math.round(nav.t) : 0).map((d) => ({ name: region_name(d.entry), fp: d.fp_now, ...(d.path ? { path: d.path } : {}), ...(d.was !== undefined ? { was: d.was, now: d.now } : {}) }));
	const icpu = interaction_cpu_of(page);
	// (whole tab: what an island of any earlier page left running is still running on this one)
	const { regs, islands: seen } = leftover_state();
	const leftovers = owned_leftovers(regs, seen, region_name, performance.now()).map(({ entry: _, ...l }) => l);
	// (the listeners holding scrolling, still attached, by the island that added each)
	const scroll_blockers = owned_scroll_listeners(scroll_listeners(), seen, region_name);
	// (what keeps the page out of the back/forward cache: its unload listeners, by owner, and — when
	// this load came from Back or Forward and was not restored — the browser's own reasons)
	const unload_owners = [...new Set(owned_scroll_listeners(unload_listeners(), seen, region_name).map((o) => o.owner))];
	const not_restored = nav ? [] : not_restored_reasons();
	const bfcache = unload_owners.length || not_restored.length ? { unload: unload_owners, ...(not_restored.length ? { not_restored } : {}) } : null;
	// the profiler's last runs (the Profiler tab's): of this page, and of each page it navigated to
	const server_profiles: Record<string, ServerProfileBrief> = {};
	for (const n of with_visit.visit?.navs ?? []) {
		const path = n.to.split('?')[0];
		const b = server_brief(path);
		if (b) server_profiles[path] = b;
	}
	const server_profile = server_brief(nav ? nav.to.split('?')[0] : location.pathname);
	// (the document's own streamed promises: after an in-app navigation they are the page before's)
	const held = nav ? null : held_open();
	const input: PageInput = { ...with_visit, ...(held ? { held_open: held } : {}), empty_slots: empty_slots(), ...(holes.length ? { hole_failures: holes } : {}), ...(code.length ? { island_code: code } : {}), ...(waits.length ? { hole_waits: waits } : {}), ...(batches.length ? { hole_batches: batches } : {}), ...(restores.length ? { restore_events: restores } : {}), ...(drift.length ? { fp_drift: drift } : {}), ...(leftovers.length ? { leftovers } : {}), ...(scroll_blockers.length ? { scroll_blockers } : {}), ...(bfcache ? { bfcache } : {}),...(icpu ? { interaction_cpu: icpu } : {}), server_profiles, ...(server_profile ? { server_profile } : {}), ...(import.meta.env.DEV ? { dev: true } : {}), ...(typeof navigator !== 'undefined' && browser_of(navigator.userAgent) ? { browser: browser_of(navigator.userAgent)! } : {}), ...(() => {
		// (the dock open as the document loaded: only the document's own paints, never after a navigation)
		const at = (globalThis as Record<symbol, unknown>)[Symbol.for('ogygia.dock-open-at')];
		return typeof at === 'number' && !last_nav() ? { dock_open_at: at } : {};
	})(), ...(() => {
		const pre = import.meta.env.DEV ? prebundled_packages((with_visit.visit?.resources ?? []).filter((r) => r.type === 'script').map((r) => r.url)) : null;
		return pre?.length ? { prebundled: pre } : {};
	})() };
	const view: PageView = { page, regions, cpu, nav, unmeasured: unmeasured(page.cpu.off), since: null, ...(waits.length ? { holes: waits } : {}), ...(holes.length ? { holes_failed: holes } : {}), report: analyze_page(input, regions, failures(), nav ? performance.now() - nav.t : performance.now(), cpu) };
	if (nav) {
		// awake here, and no wake since the navigation: the router reused it from the page before
		const woke = new Set(input.islands.map((i) => i.fp));
		// (each fingerprint once: two copies of an island with the same props share one — /props-tail's
		// twin Tally, read as the router swapped the page, keyed the dock's list twice and threw)
		const seen = new Set<string>();
		view.kept = regions
			.filter((r) => r.kind === 'island' && r.hydrated && !woke.has(r.fp) && !seen.has(r.fp) && !!seen.add(r.fp))
			.map((r) => ({ fp: r.fp, name: r.name }));
	}
	// (the first page of this document only: after an in-app navigation the vitals are not this page's)
	if (!nav) {
		const parts: NonNullable<PageView['parts']> = {};
		for (const k of ['ttfb', 'fcp', 'lcp', 'inp'] as const) {
			const p = vital_parts(input, k);
			if (p) parts[k] = p;
		}
		view.parts = parts;
	}
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
		/** the Page tab's cache check (how the host caches the content-named files), run fresh */
		__ogygia_cache?: () => Promise<{ probes: import('./cache-headers.js').CacheProbe[]; findings: import('./styles.js').StylesFinding[] }>;
	}
}

export function install_page_hook(): void {
	if (typeof window !== 'undefined' && !window.__ogygia_page) window.__ogygia_page = read_page;
	if (typeof window !== 'undefined') watch_url();
	if (typeof window !== 'undefined' && !window.__ogygia_styles)
		window.__ogygia_styles = async () => {
			const { read_styles, scan_unscoped, styles_findings } = await import('./styles.js');
			const report = read_styles(document, { match: true });
			report.unscoped = await scan_unscoped(document);
			return { report, findings: styles_findings(report) };
		};
	if (typeof window !== 'undefined' && !window.__ogygia_cache)
		window.__ogygia_cache = async () => {
			const { probe_cache, cache_findings } = await import('./cache-headers.js');
			const probes = await probe_cache(document);
			return { probes, findings: cache_findings(probes) };
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
		// (`dev`: the dev server's own doing — never "new" or "fixed" on the next load)
		findings: v.report.findings.map((f) => ({ code: f.code, names: f.fps.map((fp) => name.get(fp) ?? fp), ...(f.dev_compile ? { dev: true as const } : {}) })),
		islands: v.report.rows.map((r) => {
			// (on the dev server, the part of its load that was the server compiling its files)
			const compile_ms = Math.round(dev_compile_ms({ dev: import.meta.env.DEV ? true : undefined, visit: v.page.visit as PageInput['visit'] }, r));
			return { name: r.name, load_ms: r.load_ms, hydrate_ms: r.hydrate_ms, ...(compile_ms ? { compile_ms } : {}) };
		}),
		vitals: v.report.vitals.map((x) => ({ key: x.key, value: x.value })),
		...(v.parts ? { parts: v.parts } : {}),
		// (the page compiling on its request: the first byte's own note, not a dev-CSS shift's)
		...(v.report.findings.some((f) => f.dev_compile && (f.code === 'slow-ttfb' || f.code === 'vital-ttfb')) ? { page_compiled: true as const } : {}),
		...(v.report.findings.some((f) => f.dev_compile && (f.code === 'shift-cause' || f.code === 'vital-cls')) ? { cls_dev: true as const } : {})
	};
}
