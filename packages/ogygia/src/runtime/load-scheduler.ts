/**
 * THE LOAD SCHEDULER — every download ogygia starts on its own goes through one queue.
 *
 * Island code, a hole's HTML, a hole's prefetch, the module warm on hover, the router's page
 * prefetch: each used to pick its own moment, and on a fast-parsing page they all started together,
 * beside the page's own LCP image — a country home page's hero took 2.27 s instead of 1.19 s while
 * 206 island requests (888 KB) shared its bandwidth. Priority hints alone do not fix that (a
 * throttled or priority-blind connection splits bandwidth evenly); waiting for the right moment,
 * and capping how much background work is in flight, does.
 *
 * Every download carries a CLASS, decided by who is waiting for it:
 *  - `user`        — a visitor's gesture (an `interaction` wake, a click-time navigation, an explicit
 *                    `preload()`): never waits, fetched at high priority.
 *  - `visible`     — on screen now (an island or hole in the viewport): fetched at default priority.
 *  - `ahead`       — not on screen yet (an `idle` island, one screen ahead, a hole prefetch): low
 *                    priority, a small window.
 *  - `speculative` — a guess about the future (the router's page prefetch, its module warm): low
 *                    priority, the same window, behind every `ahead`.
 *
 * And a GATE, decided by signals, not timers ({@link critical_settled}): island CODE and every
 * background class wait until the document is parsed and painted AND the page's critical resources
 * have arrived — the image or preload its author marked `fetchpriority="high"` (the LCP resource;
 * nothing to guess) — or the visitor's first click / key (the browser stops measuring LCP there), or
 * a cap. Visible CONTENT (a hole's HTML on screen) does not wait: it IS what the visitor sees.
 *
 * A queued download's class is re-read when the queue drains, so an island scrolling into view moves
 * from `ahead` to `visible`; `promote()` lifts a queued one by hand (a click on a link whose prefetch
 * still waits). On a Kit-hydrated document Kit's own start sets the pace, so nothing waits on the
 * critical resources there (the window still applies).
 */
import { after_document_painted } from './schedule.js';
import { kit_hydrates_page } from './kit-boot.js';
import { emit as dt_emit } from '../devtools/bus.js';

const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

export type LoadClass = 'user' | 'visible' | 'ahead' | 'speculative';
/** `code`: an island's modules. `content`: HTML (a hole's answer, a prefetched page). */
export type LoadKind = 'code' | 'content';

/** How long background work waits for the page's critical resources at most. */
export const CRITICAL_CAP_MS = 2500;
/** Background (`ahead` + `speculative`) downloads in flight at once. */
export const BACKGROUND_WINDOW = 3;

const RANK: Record<LoadClass, number> = { user: 0, visible: 1, ahead: 2, speculative: 3 };

/** The fetch priority a class downloads at (`fetch(…, { priority })`, `<link fetchpriority>`). */
export function fetch_priority_of(cls: LoadClass): 'high' | 'auto' | 'low' {
	return cls === 'user' ? 'high' : cls === 'visible' ? 'auto' : 'low';
}

/** `visible` when `el` intersects the viewport now, else `ahead`. */
export function viewport_class(el: Element): 'visible' | 'ahead' {
	if (typeof innerHeight === 'undefined' || !el.isConnected) return 'ahead';
	const r = el.getBoundingClientRect();
	const visible =
		r.bottom > 0 &&
		r.right > 0 &&
		r.top < innerHeight &&
		r.left < innerWidth &&
		(r.width > 0 || r.height > 0);
	return visible ? 'visible' : 'ahead';
}

// ── the critical-resources gate ─────────────────────────────────────────────────────────────────

let input_seen = false;
const on_first_input = () => {
	input_seen = true;
	release_critical?.();
};
if (typeof document !== 'undefined') {
	for (const type of ['pointerdown', 'keydown'] as const)
		addEventListener(type, on_first_input, { capture: true, passive: true, once: true });
}

let critical: Promise<void> | null = null;
let critical_done = false;
let release_critical: (() => void) | null = null;

/** How the critical-resources wait ended: they `arrived` (or failed), the visitor's first `input`,
 *  the `cap`, or `none` were pending. */
export type CriticalOutcome = 'arrived' | 'input' | 'cap' | 'none';
let critical_report: { outcome: CriticalOutcome; resources: number; waited_ms: number } | null =
	null;
/** The critical wait's outcome once it settled (the profiler's beacon reads it), else `null`. */
export function critical_outcome(): typeof critical_report {
	return critical_report;
}

/** Elements carrying the page's critical resources that have not arrived yet: an eager
 *  `img[fetchpriority=high]` not complete, a `link[rel=preload][fetchpriority=high]` not fetched. */
function pending_critical(): Element[] {
	const out: Element[] = [];
	for (const img of document.querySelectorAll<HTMLImageElement>('img[fetchpriority="high" i]')) {
		if (img.loading === 'lazy' || img.complete) continue;
		out.push(img);
	}
	for (const link of document.querySelectorAll<HTMLLinkElement>(
		'link[rel~="preload"][fetchpriority="high" i]'
	)) {
		// one preload per breakpoint: the browser fetches only the one whose `media` matches, and the
		// others never fire `load` or `error` — waiting on them ran every such page into the cap
		if (link.media && !matchMedia(link.media).matches) continue;
		const urls = preload_urls(link);
		if (!urls.length) continue;
		// a resource-timing entry exists once the response is complete (an `imagesrcset` preload
		// fetches one of its candidates: any of them having arrived means it did)
		if (urls.some((u) => performance.getEntriesByName?.(u).length)) continue;
		out.push(link);
	}
	return out;
}

/** The URLs a preload link may fetch: its `href`, else each `imagesrcset` candidate's. */
export function preload_urls(link: HTMLLinkElement): string[] {
	if (link.href) return [link.href];
	const set = link.getAttribute('imagesrcset');
	if (!set) return [];
	const out: string[] = [];
	for (const part of set.split(',')) {
		const candidate = part.trim();
		let end = 0;
		while (end < candidate.length && candidate.charCodeAt(end) > 32) end++; // up to the descriptor
		const url = candidate.slice(0, end);
		if (!url) continue;
		try {
			out.push(new URL(url, document.baseURI).href);
		} catch {
			/* not a URL: skip the candidate */
		}
	}
	return out;
}

/**
 * Resolves once the document is parsed and painted AND its author-marked critical resources have
 * arrived (or failed) — or at the visitor's first click or key, or {@link CRITICAL_CAP_MS} into the
 * wait. A page with no marked resource resolves right after the paint. Once resolved it stays so.
 */
export function critical_settled(): Promise<void> {
	return (critical ??= after_document_painted().then(
		() =>
			new Promise<void>((resolve) => {
				const t0 = now();
				const done = (outcome: CriticalOutcome) => {
					if (critical_done) return;
					critical_done = true;
					release_critical = null;
					clearTimeout(timer);
					critical_report = {
						outcome,
						resources: waiting.length,
						waited_ms: Math.round(now() - t0)
					};
					if (DEVTOOLS) dt_emit({ domain: 'runtime', name: 'load.critical', ...critical_report });
					resolve();
					drain();
				};
				const waiting =
					input_seen || document.visibilityState === 'hidden' ? [] : pending_critical();
				const timer = waiting.length ? setTimeout(() => done('cap'), CRITICAL_CAP_MS) : undefined;
				if (!waiting.length) return done('none');
				release_critical = () => done('input');
				let left = waiting.length;
				const one = () => {
					if (--left === 0) done('arrived');
				};
				for (const el of waiting) {
					el.addEventListener('load', one, { once: true });
					el.addEventListener('error', one, { once: true });
				}
			})
	));
}

// ── the queue ───────────────────────────────────────────────────────────────────────────────────

type Entry = {
	kind: LoadKind;
	cls: () => LoadClass;
	label?: string;
	queued_at: number;
	order: number;
	resolve: (release: () => void) => void;
	background: boolean;
};

const queue: Entry[] = [];
let in_flight_background = 0;
let next_order = 0;
let scroll_watch = false;

/** A queued download: its current class, and a way to lift it. */
export interface LoadTicket {
	promote(cls: LoadClass): void;
}

/**
 * Ask for a slot. `ready` resolves with a `release` to call when the download is done (settled,
 * success or not). `cls` may be a getter, re-read whenever the queue drains (viewport changes).
 */
export function load_slot(o: {
	kind: LoadKind;
	cls: LoadClass | (() => LoadClass);
	label?: string;
}): { ready: Promise<() => void>; ticket: LoadTicket } {
	let forced: LoadClass | null = null;
	const read = typeof o.cls === 'function' ? o.cls : () => o.cls as LoadClass;
	const cls = () => {
		const c = read();
		return forced !== null && RANK[forced] < RANK[c] ? forced : c;
	};
	let resolve!: (release: () => void) => void;
	const ready = new Promise<() => void>((r) => (resolve = r));
	const entry: Entry = {
		kind: o.kind,
		cls,
		label: o.label,
		queued_at: now(),
		order: next_order++,
		resolve,
		background: false
	};
	queue.push(entry);
	if (typeof o.cls === 'function') watch_scroll();
	if (!critical_done && waits_for_critical(entry.kind, cls())) void critical_settled();
	drain();
	return {
		ready,
		ticket: {
			promote(c: LoadClass) {
				forced = c;
				drain();
			}
		}
	};
}

function waits_for_critical(kind: LoadKind, cls: LoadClass): boolean {
	if (cls === 'user') return false;
	if (kit_hydrates_page()) return false;
	return !(kind === 'content' && cls === 'visible');
}

function drain(): void {
	if (!queue.length) return;
	queue.sort((a, b) => RANK[a.cls()] - RANK[b.cls()] || a.order - b.order);
	for (let i = 0; i < queue.length;) {
		const e = queue[i];
		const cls = e.cls();
		if (!critical_done && waits_for_critical(e.kind, cls)) {
			i++;
			continue;
		}
		const background = cls === 'ahead' || cls === 'speculative';
		if (background && in_flight_background >= BACKGROUND_WINDOW) {
			i++;
			continue;
		}
		queue.splice(i, 1);
		start(e, cls, background);
	}
}

function start(e: Entry, cls: LoadClass, background: boolean): void {
	if (background) in_flight_background++;
	e.background = background;
	let released = false;
	if (DEVTOOLS)
		dt_emit({
			domain: 'runtime',
			name: 'load.started',
			class: cls,
			kind: e.kind,
			label: e.label,
			waited_ms: Math.round(now() - e.queued_at)
		});
	e.resolve(() => {
		if (released) return;
		released = true;
		if (background) in_flight_background--;
		drain();
	});
}

/** While a queued download's class can change with the viewport, re-drain on scroll (one frame). */
function watch_scroll(): void {
	if (scroll_watch || typeof addEventListener === 'undefined') return;
	scroll_watch = true;
	let framed = false;
	const on_scroll = () => {
		if (framed) return;
		framed = true;
		requestAnimationFrame(() => {
			framed = false;
			drain();
			if (!queue.length) {
				removeEventListener('scroll', on_scroll, true);
				scroll_watch = false;
			}
		});
	};
	addEventListener('scroll', on_scroll, { capture: true, passive: true });
}

function now(): number {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Test seam: a fresh document. */
export function reset_load_scheduler(): void {
	queue.length = 0;
	in_flight_background = 0;
	critical = null;
	critical_done = false;
	release_critical = null;
	critical_report = null;
	input_seen = false;
}
