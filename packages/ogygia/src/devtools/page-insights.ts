/**
 * The Page tab's brain — pure, DOM-free, so the planted-problem answer key and the unit tests run it
 * on plain data. In: what the browser saw of this document (runtime/beacon.ts `beacon_page()`), the
 * regions on the page (read off the DOM by the tab), and the bus's hydration failures. Out: the
 * vitals rated, one row per island (wake → module → turn → hydrated, with what hit it), and the
 * findings — each naming the island(s) it is about, so the tab can light them up on the page.
 *
 * Every finding is something the browser MEASURED on this visit; nothing is guessed from source.
 * Thresholds are the public web-vitals ones; the island ones are chosen so a healthy page shows
 * none (the lab page's decoys hold that line).
 */
import { without_comments as strip_comments, without_runtime_marks } from '../runtime/beacon.js';
import { hazard_fix, hazard_words, type IslandHazard } from '../profiler/hydration-hazards.js';

/** markup as a visitor's eyes compare it: no comments (Svelte's re-anchored block markers), no
 *  marks the runtime itself set on the regions inside */
const without_comments = (html: string): string => without_runtime_marks(strip_comments(html));
import { REGION_RENDER_CONCURRENCY } from '../runtime/concurrency.js';
import { fn_label, fn_label as label_of, type CpuFn, type CpuSummary } from './cpu.js';
import { third_party, third_party_findings, type ThirdParty } from './third-party.js';

export interface PageIsland {
	fp: string;
	entry?: string;
	t0: number;
	loaded: number;
	turn?: number;
	done: number;
	/** when its effects had run (a microtask after `hydrate()`), when later than `done`: its own work
	 *  ended there — `done` is when it could answer a click */
	fx?: number;
	recovered?: boolean;
	changed?: boolean;
	/** another script edited it before it woke; the runtime put the server markup back */
	healed?: boolean;
	ssr_bytes?: number;
	/** its arrived markup's block markers unpaired [openers, closers]: rewritten on the way */
	markers?: [number, number];
}

/** when an island's own work ended: its effects, when they ran after `hydrate()` returned */
const work_end = (i: PageIsland) => Math.max(i.done, i.fx ?? 0);

export interface PageInteraction {
	name: string;
	t: number;
	ms: number;
	/** input → its handlers began (the main thread was busy) */
	delay: number;
	/** the handlers */
	processing: number;
	/** handlers done → the next frame painted */
	presentation: number;
	target: string;
	fp?: string;
	/** (`forced`: of a script's time, the browser laying the page out because it read sizes after a change) */
	scripts?: { url: string; fn: string; invoker: string; ms: number; phase: 'delay' | 'handler' | 'paint'; island?: string; forced?: number }[];
}

/** The slowest interaction, sampled (JS Self-Profiling): the functions that ran while it waited and
 *  in its handlers, by their source-mapped names. `t`: which interaction (its start). */
/** The document's steps before its first byte (ms). */
export interface NavPhases {
	redirect?: number;
	worker?: number;
	dns?: number;
	connect?: number;
	tls?: number;
	/** the request until the server's first byte */
	wait?: number;
}

/** One in-app navigation (the router's body swap), on the page's clock. */
export interface PageNav {
	from: string;
	to: string;
	type: string;
	t: number;
	/** the new page's HTML arrived */
	fetched: number;
	/** its stylesheets were in */
	styled: number;
	/** the swap committed: the new page shows */
	swapped: number;
	/** the fetch split, from the page request's timing: the wait for the first byte, the download */
	server?: number;
	download?: number;
	bytes?: number;
	/** the request began before the click (a hover prefetch) */
	prefetched?: boolean;
	/** the page request on the server (the profiler's request log): its ms, the CPU it burned, its
	 *  outbound calls — what the server did with the wait */
	on_server?: { ms: number; cpu_ms: number; net_ms: number; net_count: number; inflight?: number };
}

export interface InteractionCpuInput {
	t: number;
	/** the frames' lines are the source's (mapped through a source map): else a line is the served
	 *  code's, and only the function and its file are quoted */
	mapped?: boolean;
	wait: { ms: number; top: CpuFn[] } | null;
	handler: { ms: number; top: CpuFn[] } | null;
}

/** THE PROFILER'S LAST RUN OF A PAGE, in brief (devtools: the dock's profile store, shared with the
 *  Profiler tab) — what the server did when it rendered that page */
export interface ServerProfileBrief {
	/** minutes since the run */
	ago_min: number;
	render_ms: number;
	/** its top cost, in its own words (the report's first warning, else its heaviest component) */
	top: string | null;
	calls: number;
	calls_ms: number;
	/** the Cache-Control it saw the page answer, when that keeps the page out of the back/forward
	 *  cache (no-store): the server's own answer, which the browser cannot read */
	no_store?: string;
	/** the page is prerendered: 'file' (the build's file answered, no render), 'route' (its route prerenders) */
	prerendered?: 'file' | 'route';
}

export interface PageInput {
	/** measured on the dev server (it compiles a page on its first request: a slow first byte there is
	 *  not the app's) */
	dev?: boolean;
	/** DEVTOOLS ONLY (the profiler's report is itself a profile): the profiler's last run of this
	 *  page, and of the pages it navigated to by path. Present (even empty) means: say what the server
	 *  did, or how to find out */
	server_profiles?: Record<string, ServerProfileBrief>;
	server_profile?: ServerProfileBrief;
	/** the slowest interaction's CPU, when a trace of it was taken */
	interaction_cpu?: InteractionCpuInput;
	/** what held the document open: its streamed promises by `page.data` key — when each settled
	 *  (`side` 'server': left the server, ms into the render, from the profiled render's chunks;
	 *  'browser': arrived, ms from the navigation, stamped by the resolve global) */
	held_open?: HeldOpen;
	vitals: { ttfb?: number; fcp?: number; lcp?: number; cls?: number; inp?: number };
	visit: {
		nav?: {
			dcl?: number;
			load?: number;
			res_start?: number;
			/** the document's last byte */
			res_end?: number;
			/** the document's body, decoded (bytes) */
			size?: number;
			/** the document came down as large as it is: sent without gzip or brotli */
			raw?: true;
			dom_interactive?: number;
			/** the steps before the first byte, each only when it took time */
			phases?: NavPhases;
			/** the document's own Server-Timing entries */
			server_timing?: { name: string; ms: number; desc?: string }[];
		};
		/** main-thread ms per script URL, from long animation frames (from the page's start) */
		scripts?: { url: string; ms: number; count: number }[];
		/** Svelte's hydration warnings (dev): the server and the browser disagreed, Svelte kept the server's */
		warnings?: { code: string; message: string; file?: string; fp?: string; t?: number }[];
		/** (`lcp_priority`: the largest paint's own fetchpriority, when it sets one) */
		paints?: { fcp?: number; lcp?: number; lcp_fp?: string; lcp_tag?: string; lcp_url?: string; lcp_replaced?: true; lcp_lazy?: true; lcp_priority?: 'high' | 'low' };
		resources?: { url: string; type: string; start: number; end: number; req_start?: number; res_start?: number; transfer?: number; size?: number; blocking?: boolean }[];
		/** every file by type, when the visit lists only some of them one by one */
		resource_totals?: { type: string; count: number; transfer: number; size: number }[];
		viewport?: [number, number];
		/** the page's origin (third parties are every other one) */
		origin?: string;
		/** URLs the document itself names (its scripts, preloads, their imports): a script not among
		 *  them was loaded at runtime by another script */
		named?: string[];
		/** files a preload fetched and something else downloaded again (the preload went unused) */
		preload_misses?: PreloadMiss[];
		/** preloads (image, font, stylesheet) nothing on the page used 3 s after load */
		preloads_unused?: { url: string; as: string; bytes: number }[];
		/** text files (scripts, stylesheets, JSON…) of 4 KB or more that came down as large as they are
		 *  decoded: sent without gzip or brotli, the largest first (the document's own: `nav.raw`) */
		uncompressed?: { url: string; type: string; bytes: number }[];
		/** the `@font-face` rules behind the fonts it fetched (family, font-display, the fetched files) */
		font_faces?: { family: string; display: string; urls: string[] }[];
		/** images whose pixels are 4× or more what their box shows (the screen's pixel ratio counted),
		 *  their files 50 KB or more: natural and shown sizes, the file's bytes, the island it is in */
		images_oversized?: { url: string; natural: [number, number]; shown: [number, number]; dpr: number; bytes: number; fp?: string }[];
		/** long frames (50 ms or more) that began while the page scrolled, with their two biggest scripts */
		/** (`island`: the island whose file the script is, when the profiler named it from the build's chunks) */
		scroll_jank?: { start: number; ms: number; scripts: { url: string; fn: string; invoker: string; ms: number; island?: string }[] }[];
		/** scripts that forced style and layout (5 ms or more): their window, the forced ms, the
		 *  script's file and entry function (an island's hydration shows as the runtime's own task) */
		forced_layout?: { start: number; end: number; ms: number; url: string; fn: string }[];
		/** images more than a screen and a half down, not lazy, 20 KB or more, fetched before load ended */
		images_eager_below?: { url: string; top: number; bytes: number; fp?: string }[];
		/** the srcs of shown images the browser could hold no room for (computed aspect-ratio `auto`);
		 *  empty: it looked and found none */
		images_unsized?: string[];
		/** the page's size in elements, when 1,500 or more: the deepest nesting, the element with the
		 *  most children, the islands holding the most (depth 0: past 60,000, only counted) */
		dom?: { nodes: number; depth: number; deepest: string; widest: { at: string; children: number }; islands: { fp: string; nodes: number }[] };
		/** islands whose own file failed to load and fell back to their stable name (the page came
		 *  from a build whose files are gone); `name` when the reader could name the island */
		entry_fallbacks?: { entry: string; src: string; recovered: boolean; name?: string }[];
		/** content-named files the browser fetched again (revalidated, or downloaded on a reload);
		 *  `name` when the reader could name the island */
		refetched?: { url: string; how: 'revalidated' | 'downloaded'; bytes: number; ms: number; entry?: string; runtime?: boolean; name?: string }[];
		/** the slowest interaction (the one INP reports), split by phase, with the scripts of the long
		 *  frames around it; `island` on a script when the reader could name the island its file is */
		interaction?: PageInteraction;
		/** the in-app navigations in this document */
		navs?: PageNav[];
	} | null;
	islands: PageIsland[];
	firsts: { fp: string; t: number; type: string }[];
	shifts: { t: number; value: number; fp?: string; tag?: string }[];
	longtasks: { t: number; ms: number }[];
	/** (`from`: a big island's window — where it starts in the markup without comments) */
	snapshots?: { fp: string; ssr: string; hydrated: string; final?: string; from?: number }[];
	/** awake islands showing a children slot with nothing in it (read off the DOM; devtools only) */
	empty_slots?: string[];
	/** holes whose answer never came (the bus; devtools only) */
	hole_failures?: HoleFailure[];
	/** each island's app code in dev (the dev server's module graph; devtools only) */
	island_code?: IslandCode[];
	/** how long each hole's fallback showed before its answer (the bus; devtools only) */
	hole_waits?: HoleWait[];
	/** batch requests that did not carry all their holes (the bus; devtools only) */
	hole_batches?: HoleBatch[];
	/** what the restorer of a server transform reported (runtime/restore.ts `__og_restore_log`) */
	restore_events?: RestoreEvent[];
	/** islands whose fingerprint moved between two loads of this page (devtools/fp-drift.ts) */
	fp_drift?: { name: string; fp?: string; path?: string; was?: string; now?: string }[];
	/** what islands that left the page left running (devtools/leftovers.ts; devtools only) */
	leftovers?: { name: string; intervals: number; listeners: string[]; fires: number; last_ago?: number }[];
	/** wheel / touch listeners still attached that hold scrolling (not passive), by the island (or
	 *  the file) that added each (devtools/leftovers.ts; devtools only) */
	scroll_blockers?: { owner: string; type: string; on: string; forced: boolean }[];
	/** what keeps the page out of the back/forward cache: who added a window `unload` listener, and
	 *  the browser's own reasons when this load came from Back and was not restored (devtools only) */
	bfcache?: { unload: string[]; not_restored?: string[] };
}

/** A restored host that went wrong: upgraded by its component before the restore reached it
 *  (`late`), or restored to markup that does not match Svelte's (`mismatch`, the dev check). */
export interface RestoreEvent {
	kind: 'late' | 'mismatch';
	/** the host's tag */
	host: string;
	/** page time */
	t: number;
	/** the first difference (mismatch) */
	diff?: string;
	/** the island holding it, when one does */
	island?: string;
}

export interface PreloadMiss {
	url: string;
	/** what the preload fetched as (font, fetch, script, css, img…) */
	type: string;
	/** the second download's bytes on the wire */
	bytes: number;
	/** the preload link's `as` and `crossorigin` (null: none) */
	as: string;
	crossorigin: string | null;
}

export interface HoleWait {
	name: string;
	/** ms from the hole's fetch start to its answer's swap */
	wait_ms: number;
	/** below the first screen (its fallback is not what the visitor looks at first) */
	below_fold: boolean;
	/** its server render, per request, when known (the profiler recorded the hole's requests, or
	 *  the answer's Server-Timing said) */
	server_ms?: number;
	/** its wait on the server for a render slot, before the render (Server-Timing / the profiler) */
	server_queue_ms?: number;
	/** the hole's endpoint (the devtools find its element by it: a hole has no fingerprint) */
	endpoint?: string;
	/** page times: when the fallback began to count (the paint, or the hole's own start), and its
	 *  request as the browser timed it — left, first byte back, last byte. They split the wait. */
	shown_at?: number;
	left_at?: number;
	first_at?: number;
	end_at?: number;
	/** it came in ONE batch request with the holes that started with it: how many (its own part
	 *  landed when the server rendered it — `first_at` is that, out of order). No browser gate held it. */
	batch_size?: number;
}

/** A batch request (runtime/frame-nav.ts) that carried fewer holes than it was sent for: the rest
 *  fetched on their own right after it. */
export interface HoleBatch {
	sent: number;
	delivered: number;
	/** the response's status (0: the request failed) */
	status: number;
	refused?: 'redirected' | 'document';
	final_url?: string;
	/** the holes it was for (names) */
	names: string[];
}

/** The runtime runs this many hole requests at once (runtime/session.ts `server_gate`). */
const HOLE_GATE = 3;

export interface IslandCode {
	fp?: string;
	name: string;
	/** the island's app code, served size in dev */
	bytes: number;
	/** its heaviest modules */
	top: { file: string; bytes: number }[];
	/** re-export barrels still imported whole, with the app modules each drags in */
	barrels: { file: string; fanout: number }[];
	/** its components' lines that draw differently in the browser (the dev server read their sources) */
	hazards?: IslandHazard[];
}

export interface HoleFailure {
	fp?: string;
	name: string;
	endpoint?: string;
	reason: 'redirected' | 'document' | 'error';
	final_url?: string;
	message?: string;
	attempts: number;
}

/** A region on the page, as the tab read it off the DOM. `top` is document-relative (px). */
export interface RegionFact {
	fp: string;
	name: string;
	kind: 'island' | 'lake' | 'hole';
	wake: string;
	hydrated: boolean;
	top?: number;
	height?: number;
	/** the wire bytes only this island loads (a build's island graph × the browser's sizes) */
	own_bytes?: number;
	/** it draws nothing on this screen: no box of its own nor a child's (hidden by its CSS, or empty) */
	hidden?: true;
	/** the media query under which the page's CSS shows it (read off the sheets), when one does */
	shows_at?: string;
	/** it never draws: no text, only `hidden` marker elements — an island there for its effects */
	headless?: true;
}

export interface Failure {
	fp?: string;
	message: string;
	/** its wake → the failure (page clock): the island was loading, and held its turn, meanwhile */
	span?: [number, number];
}

export type Rating = 'good' | 'fair' | 'poor';
export interface RatedVital {
	key: 'ttfb' | 'fcp' | 'lcp' | 'cls' | 'inp';
	label: string;
	value: number;
	rating: Rating;
}

export interface IslandRow {
	fp: string;
	name: string;
	wake: string;
	/** wake began → module + hydrate core loaded */
	load_ms: number;
	/** loaded → its scheduler turn (the queue behind other islands, and the DCL/paint gate) */
	queue_ms: number | null;
	/** the synchronous hydrate step */
	hydrate_ms: number;
	t0: number;
	done: number;
	recovered: boolean;
	changed: boolean;
	/** layout shift (summed) this island caused within a moment of hydrating */
	shift: number;
	/** long-task ms that overlapped its hydration window */
	longtask_ms: number;
	/** the first interaction reached it before it was awake (ms early), when it did */
	early_ms: number | null;
	below_fold: boolean;
	/** main-thread CPU sampled inside its hydrate window (null: no trace) */
	cpu_ms: number | null;
}

export type Severity = 'error' | 'warn' | 'info';
export interface HeldOpen {
	side: 'server' | 'browser';
	keys: { key: string | null; at: number }[];
	/** server side: the early part's last byte left at `early_ms`, the tail's (`late_bytes`) at `late_ms` */
	early_ms?: number;
	early_bytes?: number;
	late_ms?: number;
	late_bytes?: number;
	/** server side: the islands the page renders (the finding needs some to be about) */
	islands?: number;
}

/**
 * The page seed's defer ids → the `page.data` key each stands for (top level and one level down):
 * the seed (`application/ogygia-page`, the flat devalue form) holds a defer marker `[name, i]` per
 * streamed promise, the marker's payload the id the streamed resolve script settles. From the whole
 * document's HTML or the seed script's own text. indexOf only.
 */
export function defer_keys(html: string, marker = 'OgygiaDefer'): Map<number, string> {
	const out = new Map<number, string>();
	let text = html;
	const at = html.indexOf('application/ogygia-page');
	if (at !== -1) {
		const open = html.indexOf('>', at);
		const close = html.indexOf('</script', open);
		if (open === -1 || close === -1) return out;
		text = html.slice(open + 1, close);
	}
	let arr: unknown[];
	try {
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed)) return out;
		arr = parsed;
	} catch {
		return out;
	}
	// (every value is an index into the array; a reducer is [name, index])
	const id_of = (i: unknown): number | null => {
		const v = typeof i === 'number' ? arr[i] : undefined;
		if (!Array.isArray(v) || v[0] !== marker) return null;
		let p: unknown = arr[v[1] as number];
		if (Array.isArray(p)) p = arr[p[0] as number];
		return typeof p === 'number' ? p : null;
	};
	const root = arr[0] as Record<string, unknown> | undefined;
	const data = root && typeof root.data === 'number' ? arr[root.data] : undefined;
	if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
	for (const [key, idx] of Object.entries(data as Record<string, unknown>)) {
		const id = id_of(idx);
		if (id !== null) {
			out.set(id, key);
			continue;
		}
		const inner = typeof idx === 'number' ? arr[idx] : undefined;
		if (inner && typeof inner === 'object' && !Array.isArray(inner))
			for (const [k2, i2] of Object.entries(inner as Record<string, unknown>)) {
				const id2 = id_of(i2);
				if (id2 !== null) out.set(id2, `${key}.${k2}`);
			}
	}
	return out;
}

export interface PageFinding {
	code: string;
	severity: Severity;
	message: string;
	fix?: string;
	/** the islands it is about (to light up on the page) */
	fps: string[];
	/** it is the dev server's own doing: its first compile of the page (a slow first byte while the
	 *  page compiled on its first request), or the CSS it adds with JavaScript moving the page (a
	 *  shift). A reload reads it differently: "since your last load" never calls it new or fixed */
	dev_compile?: true;
}

export interface PageReport {
	vitals: RatedVital[];
	rows: IslandRow[];
	findings: PageFinding[];
	/** blocking resources before first paint, slowest first */
	blocking: { url: string; ms: number; bytes: number }[];
	bytes: { type: string; count: number; transfer: number; size: number }[];
	longtask_ms: number;
	/** other origins on this page (null: none, or no origin to tell them by) */
	third_party: ThirdParty | null;
}

// web-vitals thresholds: [good up to, poor from]
const LIMITS: Record<RatedVital['key'], [number, number, string]> = {
	ttfb: [800, 1800, 'TTFB'],
	fcp: [1800, 3000, 'FCP'],
	lcp: [2500, 4000, 'LCP'],
	cls: [0.1, 0.25, 'CLS'],
	inp: [200, 500, 'INP']
};

/**
 * THE INLINE THRESHOLD THAT TAKES THE SMALL SHEETS OFF THE PAINT: Kit inlines its route stylesheets
 * under `inlineStyleThreshold` (ogygia's island sheets follow the same setting), as `<style>` in the
 * HTML — no request to wait on. Of the blocking build stylesheets (`/_app/immutable/`), the smallest
 * first, while each is 8 KB or less and the HTML grows by 24 KB at most: the threshold that inlines
 * them (just over the largest, in whole KB), how many, how many bytes. Null under two sheets. The
 * profiler's page weight (`style`) and the Page tab's resources (`css`) both ask it.
 */
export function inline_threshold_tune(blocking: readonly { url: string; kind: string; bytes: number }[]): { threshold: number; files: number; bytes: number } | null {
	const sheets = blocking.filter((x) => (x.kind === 'style' || x.kind === 'css') && x.url.includes('/_app/immutable/') && x.bytes > 0).sort((a, b) => a.bytes - b.bytes);
	let files = 0;
	let bytes = 0;
	let largest = 0;
	for (const s of sheets) {
		if (s.bytes > 8 * 1024 || bytes + s.bytes > 24 * 1024) break;
		files++;
		bytes += s.bytes;
		largest = s.bytes;
	}
	if (files < 2) return null;
	return { threshold: (Math.floor(largest / 1024) + 1) * 1024, files, bytes };
}

/** the named islands' own lines that draw differently in the browser (the dev server's reading) */
function hazards_of(page: PageInput, names: readonly string[]): IslandHazard[] {
	const want = new Set(names);
	return (page.island_code ?? []).filter((c) => want.has(c.name)).flatMap((c) => c.hazards ?? []);
}

/** text sent uncompressed: named past this many bytes in all (the HTML and the files), a warning past
 *  the second (on a slow connection, ~100 KB uncompressed is most of a second more) */
const UNCOMPRESSED_FINDING = 20 * 1024;
const UNCOMPRESSED_WARN = 100 * 1024;
/** eager islands below the first screen whose own code is this many wire bytes: a warning */
const EAGER_BELOW_WARN = 50 * 1024;
/** …and under this, its bytes are not the point: its hydration is */
const EAGER_BELOW_SMALL = 4 * 1024;
/** a shift counts against an island when it lands within this long after the island hydrated */
const SHIFT_WINDOW_MS = 600;
/** a hydrate step this long is a long task of its own */
const LONG_HYDRATE_MS = 50;
/** waiting this long for a turn after the module arrived */
const LONG_QUEUE_MS = 150;
/** a hole on the first screen whose fallback showed this long (a skeleton a visitor stares at) */
const SLOW_HOLE_MS = 1000;
/** a wait with nothing ahead this long is the scheduler's own (its viewport snapshot waits at most
 *  48 ms by design, and its first report lands within a frame or two) */
const HELD_IDLE_MS = 40;
/** an in-app navigation this long before the new page shows is felt (a click that seems to do
 *  nothing); twice past a second, a warning */
const SLOW_NAV_MS = 400;
const SLOW_NAV_WARN_MS = 1000;
/** a module load this slow */
const SLOW_LOAD_MS = 800;
/** an above-the-fold island still asleep this long after the largest paint */
const LATE_MS = 1000;
/** a wake-at-load island still asleep this long after the load event */
const NEVER_MS = 3000;
/** a page of this many elements or more is named (the beacon reports from the same count) */
export const DOM_LARGE = 1500;
/** early by less than this is a tie, not a lost click */
const EARLY_SLACK_MS = 8;

const EAGER = new Set(['load', 'idle']);

const round = (n: number, d = 1) => {
	const k = 10 ** d;
	return Math.round(n * k) / k;
};

export function rate(key: RatedVital['key'], value: number): Rating {
	const [good, poor] = LIMITS[key];
	return value <= good ? 'good' : value < poor ? 'fair' : 'poor';
}

/** Two markups that differ, and differ only in percent-encoding (`a/b` against `a%2Fb`): equal
 *  once both are decoded. A stray `%` that is not an escape (text reading "50%") makes it `false`. */
export function encoding_only(a: string, b: string): boolean {
	a = without_comments(a);
	b = without_comments(b);
	if (a === b || (!a.includes('%') && !b.includes('%'))) return false;
	try {
		return decodeURIComponent(a) === decodeURIComponent(b);
	} catch {
		return false;
	}
}

/** Where two strings first differ, as a short "server … / now …" pair (the markup-changed proof). */
export function first_difference(a: string, b: string, span = 60): { at: number; server: string; now: string } | null {
	// (Svelte's block markers are re-anchored on hydration and nobody sees them)
	a = without_comments(a);
	b = without_comments(b);
	if (a === b) return null;
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	// start at a word (or tag) edge a little before the change, so the pair reads
	let from = Math.max(0, i - 24);
	for (let j = i - 1; j >= Math.max(0, i - 24); j--) {
		const c = a[j];
		if (c === ' ' || c === '>') {
			from = j + 1;
			break;
		}
	}
	return { at: i, server: a.slice(from, i + span), now: b.slice(from, i + span) };
}

/** At the first difference `at`: an attribute of a CUSTOM ELEMENT empty on the server (`name=""`)
 *  that the browser holds as `"true"` / `"false"` — written bare (Svelte hands a custom element its
 *  attributes as values, and a bare one's is `true`; measured: `={true}` and `=""` agree on both
 *  sides). Its name, the element's tag, the browser's value. */
export function boolean_attr_at(server: string, now: string, at: number): { name: string; tag: string; now: 'true' | 'false' } | null {
	if (at < 2 || server.charCodeAt(at - 1) !== 34 || server.charCodeAt(at - 2) !== 61 || server.charCodeAt(at) !== 34) return null;
	const v = now.startsWith('true"', at) ? 'true' : now.startsWith('false"', at) ? 'false' : null;
	if (!v) return null;
	let s = at - 2;
	while (s > 0) {
		const c = server.charCodeAt(s - 1);
		if (c === 32 || c === 10 || c === 9 || c === 60 || c === 34) break;
		s--;
	}
	const name = server.slice(s, at - 2);
	// the element it sits on: its tag, from the `<` before it (a custom element's name holds a `-`)
	const lt = server.lastIndexOf('<', s);
	if (!name || lt === -1) return null;
	let e = lt + 1;
	while (e < s && server.charCodeAt(e) !== 32 && server.charCodeAt(e) !== 10 && server.charCodeAt(e) !== 9) e++;
	const tag = server.slice(lt + 1, e);
	return tag.indexOf('-') !== -1 ? { name, tag, now: v } : null;
}

export function analyze_page(page: PageInput, regions: RegionFact[], failures: Failure[] = [], now = Infinity, cpu: CpuSummary | null = null): PageReport {
	/** " — mostly in `fn (file:line)`" from the CPU trace, for a finding about this island (or '') */
	const why_cpu = (fp: string | null): string => {
		const f = fp ? cpu?.islands[fp]?.top[0] : cpu?.outside.top[0];
		if (!f || f.self_ms < 5) return '';
		// (the island's own component: its name once — "Thrash (… mostly its own code (Thrash.svelte:5))")
		if (fp && f.name === name_of(fp) && f.file) return `; mostly its own code (${f.file.slice(f.file.lastIndexOf('/') + 1)}${f.line !== null ? `:${f.line}` : ''})`;
		return `; mostly ${fn_label(f)}`;
	};
	/** " — mostly <script>" from the long animation frames, when no CPU trace names it (or '') */
	const why_script = (): string => {
		const top = page.visit?.scripts?.[0];
		if (!top || top.ms < 30) return '';
		const q = top.url.indexOf('?');
		const path = q === -1 ? top.url : top.url.slice(0, q);
		let where = path;
		try {
			const u = new URL(path);
			where = (page.visit?.origin && u.origin === page.visit.origin ? '' : u.host) + u.pathname;
		} catch {
			// keep the raw URL
		}
		return `; mostly ${where} (${Math.round(top.ms)} ms)`;
	};
	const findings: PageFinding[] = [];
	const by_fp = new Map<string, RegionFact>();
	for (const r of regions) if (r.fp && !by_fp.has(r.fp)) by_fp.set(r.fp, r);
	const name_of = (fp: string | undefined, entry?: string) => (fp && by_fp.get(fp)?.name) || entry || fp || 'an island';
	const vh = page.visit?.viewport?.[1] ?? 0;
	const vw = page.visit?.viewport?.[0] ?? 0;

	// ── vitals ──
	const vitals: RatedVital[] = [];
	for (const key of ['ttfb', 'fcp', 'lcp', 'cls', 'inp'] as const) {
		const v = page.vitals[key];
		if (typeof v !== 'number' || !Number.isFinite(v)) continue;
		vitals.push({ key, label: LIMITS[key][2], value: v, rating: rate(key, v) });
	}

	// ── one row per island hydration (the latest per fingerprint: a re-wake after a nav replaces it) ──
	const latest = new Map<string, PageIsland>();
	for (const i of page.islands) latest.set(i.fp, i);
	// (the dev server adds a component's CSS with JavaScript after the first paint: a shift right after
	// one of those landed is the CSS's, not the island's waking — /blocks: the CSS at 42 ms, the shift
	// at 47 ms, the island done at 64 ms, in and out of the island's window load to load. A build links
	// its CSS in the head: none of this there)
	// A COMPONENT'S OWN SHEET moves only that component and what follows it: one of another island's
	// that sits below the moved island cannot have pushed it (a phone-only bar's sheet at the page's
	// foot landing as a banner opened above it excused the banner)
	const island_tops = new Map<string, number[]>();
	for (const r of regions)
		if (r.kind === 'island' && typeof r.top === 'number') (island_tops.get(r.name) ?? island_tops.set(r.name, []).get(r.name)!).push(r.top);
	const sheet_of = (url: string): string | null => {
		const q = url.indexOf('.svelte?');
		return q === -1 ? null : url.slice(url.lastIndexOf('/', q) + 1, q);
	};
	const dev_css = page.dev ? (page.visit?.resources ?? []).filter((r) => r.url.includes('type=style')).map((r) => ({ end: r.end, of: sheet_of(r.url) })) : [];
	const by_dev_css = (t: number, name: string, top: number | undefined) =>
		dev_css.some((e) => {
			if (e.end > t + 5 || t - e.end > 250) return false;
			const tops = e.of && e.of !== name ? island_tops.get(e.of) : undefined;
			return !(tops && typeof top === 'number' && tops.every((x) => x > top));
		});
	const rows: IslandRow[] = [];
	for (const i of latest.values()) {
		const fact = by_fp.get(i.fp);
		const lo = i.turn ?? i.loaded;
		// (the island's own work: its hydrate step and the effects Svelte runs right after it)
		const end = work_end(i);
		let shift = 0;
		for (const s of page.shifts) if (s.fp === i.fp && s.t >= i.done - 16 && s.t <= end + SHIFT_WINDOW_MS && !by_dev_css(s.t, fact?.name ?? '', fact?.top)) shift += s.value;
		let lt = 0;
		for (const t of page.longtasks) {
			const a = Math.max(t.t, lo);
			const b = Math.min(t.t + t.ms, end);
			if (b > a) lt += b - a;
		}
		const first = page.firsts.find((f) => f.fp === i.fp);
		const early = first && first.t < i.done - EARLY_SLACK_MS ? i.done - first.t : null;
		rows.push({
			fp: i.fp,
			name: name_of(i.fp, i.entry),
			wake: fact?.wake ?? '',
			load_ms: round(Math.max(0, i.loaded - i.t0)),
			queue_ms: i.turn !== undefined ? round(Math.max(0, i.turn - i.loaded)) : null,
			hydrate_ms: round(Math.max(0, end - lo)),
			t0: i.t0,
			done: end,
			recovered: !!i.recovered,
			changed: !!i.changed,
			shift: round(shift, 4),
			longtask_ms: round(lt),
			early_ms: early === null ? null : round(early),
			below_fold: !!(fact && vh && typeof fact.top === 'number' && fact.top >= vh),
			cpu_ms: cpu ? (cpu.islands[i.fp]?.ms ?? 0) : null
		});
	}
	rows.sort((a, b) => a.t0 - b.t0);

	// ── failures and recoveries: the page is broken there ──
	for (const f of failures) {
		// the first line: Svelte's dev build appends the component stack ("in <unknown> in X.svelte")
		let why = f.message.split('\n')[0].trim();
		while (why.endsWith('.')) why = why.slice(0, -1);
		findings.push({
			code: 'hydrate-failed',
			severity: 'error',
			message: `${name_of(f.fp)} failed to hydrate: ${clip(why)}. It shows its server HTML and does nothing.`,
			fix: 'Open the browser console for the stack; the island module threw while loading or mounting.',
			fps: f.fp ? [f.fp] : []
		});
	}
	const all_recovered = rows.filter((r) => r.recovered);
	// WHO CHANGED IT: a script that edited the island before it woke (the runtime put the server
	// markup back: `healed`), or a server transform the restorer reported. Neither seen: nothing
	// touched the markup — the component itself drew another tree in the browser
	const touched_page = !!page.restore_events?.length;
	// THE SAME MARKUP CAME BACK: what it drew in the browser, comments aside, is what it threw away
	// (the beacon compared them) — its code drew no other tree, so no line of it is to blame: only
	// Svelte's hidden block markers disagreed. A kept island's host once did exactly this
	const same = touched_page
		? []
		: all_recovered.filter((r) => {
				const i = page.islands.find((x) => x.fp === r.fp);
				return !r.changed && !i?.healed && i?.ssr_bytes !== undefined;
			});
	// …WITH ITS MARKERS UNPAIRED AS IT ARRIVED: a render always pairs them, so something rewrote them
	// between the server and the browser (a post-SSR pass, a comment-stripping proxy) — the cause, named
	const rewired = same.filter((r) => page.islands.find((x) => x.fp === r.fp)?.markers);
	if (rewired.length) {
		const one = rewired.length === 1;
		const m = page.islands.find((x) => x.fp === rewired[0].fp)!.markers!;
		findings.push({
			code: 'recovered',
			severity: 'error',
			message:
				`${list(rewired.map((r) => r.name))} threw away the server HTML and rendered again in the browser (a flash and a double render): ${one ? 'its' : 'their'} markup arrived with Svelte's hidden block markers unpaired (${one ? '' : `${rewired[0].name}: `}${m[0]} opening, ${m[1]} closing), and a render always pairs them. ` +
				`Something rewrote ${one ? 'it' : 'them'} between the server and the browser; the markup the component drew is the same.`,
			fix: 'Find the rewrite: a transformPageChunk or HTML middleware after the render, an edge rewriter, or a proxy that strips HTML comments. Keep it out of ogygia-region subtrees (or run it before ogygia’s render), and let comments through.',
			fps: rewired.map((r) => r.fp)
		});
	}
	const host_shape = same.filter((r) => !rewired.includes(r));
	if (host_shape.length) {
		const same = host_shape;
		const one = same.length === 1;
		findings.push({
			code: 'recovered',
			severity: 'error',
			message:
				`${list(same.map((r) => r.name))} threw away the server HTML and rendered again in the browser (a flash and a double render) — and drew the same markup ${one ? 'it' : 'they'} threw away: only Svelte's hidden block markers disagreed. ` +
				`${one ? 'Its' : 'Their'} code drew no other tree: the island's host and its server render disagree on structure (a wrapper of ogygia's), or a block ({#if}, {#each}) took another branch to the same output.`,
			fix: "Report it to ogygia with this page and how the island is placed (keep:, inside a snippet, nested in another island): a host that hydrates in another shape than it renders is ogygia's bug. If a block's two branches draw the same thing, give them one branch.",
			fps: same.map((r) => r.fp)
		});
	}
	const recovered = all_recovered.filter((r) => !same.includes(r));
	if (recovered.length) {
		const touched = recovered.some((r) => page.islands.find((i) => i.fp === r.fp)?.healed) || touched_page;
		const lines = touched ? [] : hazards_of(page, recovered.map((r) => r.name));
		findings.push({
			code: 'recovered',
			severity: 'error',
			message:
				`${list(recovered.map((r) => r.name))} threw away the server HTML and rendered again in the browser (a flash and a double render). ` +
				(touched
					? 'Something changed the markup between the server and hydration.'
					: 'No script in the browser edited ' + (recovered.length === 1 ? 'it' : 'them') + ' before waking: either its HTML was rewritten on the way from the server, or the component itself drew a different tree in the browser.' + (lines.length ? ` ${hazard_words(lines)}` : '')),
			fix: touched
				? 'Look for a script that edits the page before islands wake (an A/B tool, a DOM injector), or markup the browser rewrites (invalid nesting like a <div> in a <p>).'
				: lines.length
					? `${hazard_fix(lines)} If it is none of them, look for a rewrite on the way (a transformPageChunk, an HTML middleware or edge rewriter).`
					: 'Look for a rewrite on the way (a transformPageChunk, an HTML middleware or edge rewriter), then in its components for what the browser sees differently: a block ({#if}, {#each}, {#await}) whose condition reads `window`, `Date`, `Math.random()` or storage; a context set only on the server (a csr=false layout\'s setContext); an `await` at the top of its script; or markup the browser rewrites (a <div> in a <p>).',
			fps: recovered.map((r) => r.fp)
		});
	}

	// ── the markup changed on hydration (no recovery: Svelte patched it in place) ──
	// (an island whose two markups differ only in how a URL is percent-encoded — `a/b` against
	// `a%2Fb`, a form action SvelteKit's server writes one way and its browser side the other — shows
	// the same thing: a note, not "the page changes as it wakes")
	const all_changed = rows.filter((r) => r.changed && !r.recovered);
	const encoded = all_changed.filter((r) => {
		const s = page.snapshots?.find((x) => x.fp === r.fp);
		return !!s && encoding_only(s.ssr, s.hydrated);
	});
	const changed = all_changed.filter((r) => !encoded.includes(r));
	if (encoded.length) {
		const s = page.snapshots!.find((x) => x.fp === encoded[0].fp)!;
		const d = first_difference(s.ssr, s.hydrated);
		findings.push({
			code: 'markup-encoded',
			severity: 'info',
			message: `${list(encoded.map((r) => r.name))} rendered the same markup in the browser but for how a URL is encoded${d ? ` (server "${clip(d.server)}", browser "${clip(d.now)}")` : ''}: the same address, nothing changes on screen.`,
			fix: 'Nothing to fix for a visitor. If a test or a cache compares the HTML byte for byte, write the URL the same way on both sides (both encoded, or neither).',
			fps: encoded.map((r) => r.fp)
		});
	}
	if (changed.length) {
		const snap = page.snapshots?.find((s) => s.fp === changed[0].fp);
		const d = snap ? first_difference(snap.ssr, snap.hydrated) : null;
		// a harmless-looking cause: a bare attribute on a custom element (`<my-card data-x>`, Svelte 5)
		const bool = d && snap ? boolean_attr_at(without_comments(snap.ssr), without_comments(snap.hydrated), d.at) : null;
		// (the lines of its own that draw differently in the browser: the dev server read them)
		const changed_lines = hazards_of(page, changed.map((r) => r.name));
		findings.push({
			code: 'markup-changed',
			severity: 'warn',
			message:
				`${list(changed.map((r) => r.name))} rendered different markup in the browser than on the server, so the page changes as it wakes.` +
				(d ? ` First difference in ${changed[0].name}: server "${clip(d.server)}", browser "${clip(d.now)}".` : '') +
				(changed_lines.length && !bool ? ` ${hazard_words(changed_lines)}` : ''),
			fix: bool
				? `\`${bool.name}\` on <${bool.tag}> is written bare: the server writes ${bool.name}="" and Svelte's hydrate sets it to "${bool.now}" — Svelte hands a custom element its attributes as values, and a bare attribute's value is \`true\`. So the island's markup changes as it wakes, and CSS or the component reading the value sees two. Give it a value, the same on both sides: \`${bool.name}=""\` (or \`${bool.name}="true"\` when the component reads it as a flag).`
				: changed_lines.length
					? hazard_fix(changed_lines)
					: 'Render the same thing on both sides: move time, random values, and browser-only reads (window, localStorage) into an effect or an event, or pass them in as props.',
			fps: changed.map((r) => r.fp)
		});
	}

	// ── clicks that landed before the island was awake ──
	const early = rows.filter((r) => r.early_ms !== null && r.wake !== 'interaction');
	// (and islands clicked that have not woken at all)
	const asleep_hit = page.firsts
		.map((f) => by_fp.get(f.fp))
		.filter((r): r is RegionFact => !!r && r.kind === 'island' && r.wake !== 'interaction' && !r.hydrated && !latest.has(r.fp));
	const early_labels = [...early.map((r) => `${r.name} (${Math.round(r.early_ms!)} ms before it woke)`), ...asleep_hit.map((r) => `${r.name} (still asleep)`)];
	if (early_labels.length)
		findings.push({
			code: 'early-click',
			severity: 'warn',
			message: `A visitor reached ${list(early_labels)} before it was awake, so the first click did nothing.`,
			fix: "Wake it sooner (a smaller module, or wake='load' if it is idle), or use wake='interaction' so the first click wakes it and is replayed.",
			fps: [...early.map((r) => r.fp), ...asleep_hit.map((r) => r.fp)]
		});

	// ── hydrating moved the layout ──
	const shifted = rows.filter((r) => r.shift >= 0.01);
	if (shifted.length)
		findings.push({
			code: 'hydration-shift',
			severity: shifted.some((r) => r.shift >= 0.1) ? 'warn' : 'info',
			message: `Hydrating ${list(shifted.map((r) => `${r.name} (CLS ${r.shift})`))} moved the layout: the island's size changed when it woke.`,
			fix: 'Render the island at its final size on the server (the same content, or a placeholder with a fixed height), so waking it changes nothing on screen.',
			fps: shifted.map((r) => r.fp)
		});

	// ── one hydrate step long enough to block the page ──
	const heavy = rows.filter((r) => r.hydrate_ms >= LONG_HYDRATE_MS);
	if (heavy.length)
		findings.push({
			code: 'long-hydrate',
			severity: 'warn',
			message: `${list(heavy.map((r) => `${r.name} (${r.hydrate_ms} ms${why_cpu(r.fp)})`))} took one long task to hydrate. The page cannot respond to input while it runs.`,
			fix: 'Do less at mount: defer work the first paint does not need to an effect or idle callback, render long lists lazily, or split the island.',
			fps: heavy.map((r) => r.fp)
		});

	// ── queued behind other islands ──
	const queued = rows.filter((r) => r.queue_ms !== null && r.queue_ms >= LONG_QUEUE_MS);
	if (queued.length) {
		// what ran in the wait: the hydrate steps of the islands that went first
		const ahead = new Map<string, number>();
		for (const q of queued) {
			const a = q.t0 + q.load_ms;
			const b = a + (q.queue_ms ?? 0);
			for (const o of rows) {
				if (o === q) continue;
				const lo = o.done - o.hydrate_ms;
				const hit = Math.min(b, o.done) - Math.max(a, lo);
				if (hit > 1) ahead.set(o.name, Math.max(ahead.get(o.name) ?? 0, o.hydrate_ms));
			}
		}
		const top = [...ahead].sort((x, y) => y[1] - x[1]).slice(0, 3);
		// what a below-the-fold island was HELD for: a first-screen island still loading its code in
		// the wait (viewport first holds the ready ones below it, up to a second) — a failed one too
		const held_for = new Map<string, { ms: number; failed: boolean }>();
		for (const q of queued) {
			if (!q.below_fold) continue;
			const a = q.t0 + q.load_ms;
			const b = a + (q.queue_ms ?? 0);
			const spans: { name: string; s: number; e: number; failed: boolean }[] = rows.filter((o) => o !== q && !o.below_fold).map((o) => ({ name: o.name, s: o.t0, e: o.t0 + o.load_ms, failed: false }));
			for (const f of failures) {
				if (!f.span || !f.fp) continue;
				const top_px = by_fp.get(f.fp)?.top;
				if (typeof top_px === 'number' && vh && top_px >= vh) continue;
				spans.push({ name: name_of(f.fp), s: f.span[0], e: f.span[1], failed: true });
			}
			for (const sp of spans) {
				const hit = Math.min(b, sp.e) - Math.max(a, sp.s);
				if (hit >= 50) held_for.set(sp.name, { ms: Math.max(held_for.get(sp.name)?.ms ?? 0, hit), failed: sp.failed });
			}
		}
		const holders = [...held_for].sort((x, y) => y[1].ms - x[1].ms).slice(0, 3);
		const held_ms = holders[0]?.[1].ms ?? 0;
		findings.push({
			code: 'queued',
			severity: 'info',
			message:
				`${list(queued.map((r) => `${r.name} (${r.queue_ms} ms)`))} had its code but waited for its turn` +
				(holders.length && held_ms >= (top[0]?.[1] ?? 0)
					? `, held for ${list(holders.map(([n, h]) => `${n} (${Math.round(h.ms)} ms${h.failed ? ', which then failed' : ''})`))} on the first screen, still loading ${holders.length === 1 ? 'its' : 'their'} code: viewport first, the islands a visitor sees wake before the ones below.`
					: top.length && top[0][1] >= 10
						? `, behind ${list(top.map(([n, m]) => `${n} (${Math.round(m)} ms)`))}: islands hydrate one per task, viewport first.`
						: ': islands hydrate after the page is parsed and painted, one per task, viewport first.'),
			fix:
				holders.length && held_ms >= (top[0]?.[1] ?? 0)
					? `The first-screen island${holders.length === 1 ? '' : 's'} loading slowly ${holders.length === 1 ? 'is' : 'are'} the cost: make ${holders.length === 1 ? 'its' : 'their'} code smaller or faster to load${holders.some(([, h]) => h.failed) ? ' (and fix the one that failed)' : ''}. The hold is bounded (a second), so a module that never comes cannot stall the rest.`
					: 'The islands ahead of it are the cost. Make them lighter, or move islands that are not needed at load to wake=\'visible\' or \'idle\'.',
			fps: queued.map((r) => r.fp)
		});
	}

	// ── the document held open: every island waited for its end ──
	{
		const f = explain_held_open(page, rows, name_of);
		if (f) findings.push(f);
	}

	// ── held with nothing ahead: the runtime's own wait ──
	// A wait for the turn is a queue only while other islands hydrate. What the page explains: the
	// start gate (islands wake after DOMContentLoaded and a painted frame), and a below-the-fold
	// island held while a first-screen one still loads its code. Whatever is left, the scheduler
	// held on its own. That is ogygia's cost, not the page's — a watcher that silenced the
	// scheduler's viewport snapshot once made 200 scrolled-into-view islands wait 62–84 ms each,
	// with nothing ahead, and no finding said so.
	{
		const gate = Math.max(page.visit?.nav?.dcl ?? 0, page.visit?.paints?.fcp ?? 0) + 20;
		const steps = rows.map((o) => [o.done - o.hydrate_ms, o.done] as const);
		const held: { r: IslandRow; idle: number }[] = [];
		for (const r of rows) {
			if (r.queue_ms === null || r.queue_ms < HELD_IDLE_MS) continue;
			const a = Math.max(r.t0 + r.load_ms, gate);
			const b = r.t0 + r.load_ms + r.queue_ms;
			if (b - a < HELD_IDLE_MS) continue;
			// the spans inside [a, b] where another island hydrated, or a first-screen one was loading
			// its code while this one sits below the fold: merged, so overlaps count once
			const busy: [number, number][] = [];
			for (let i = 0; i < rows.length; i++) {
				const o = rows[i];
				if (o === r) continue;
				busy.push([steps[i][0], steps[i][1]]);
				if (r.below_fold && !o.below_fold) busy.push([o.t0, o.t0 + o.load_ms]);
			}
			// …and a first-screen island that FAILED: it is no row (it never hydrated), but it was
			// loading from its wake to its failure, and the scheduler held this one for it meanwhile
			// (a slow first compile of the failing island read as ogygia's own wait)
			if (r.below_fold)
				for (const f of failures) {
					if (!f.span || !f.fp) continue;
					const top = by_fp.get(f.fp)?.top;
					if (typeof top === 'number' && vh && top >= vh) continue;
					busy.push([f.span[0], f.span[1]]);
				}
			busy.sort((x, y) => x[0] - y[0]);
			let covered = 0;
			let at = a;
			for (const [s, e] of busy) {
				const lo = Math.max(s, at);
				const hi = Math.min(e, b);
				if (hi > lo) {
					covered += hi - lo;
					at = hi;
				}
			}
			const idle = b - a - covered;
			if (idle >= HELD_IDLE_MS) held.push({ r, idle });
		}
		if (held.length) {
			const med = [...held].sort((x, y) => x.idle - y.idle)[held.length >> 1].idle;
			findings.push({
				code: 'held-idle',
				severity: 'warn',
				message:
					`${held.length === 1 ? held[0].r.name : `${held.length} islands`} had ${held.length === 1 ? 'its' : 'their'} code but waited ${held.length === 1 ? Math.round(held[0].idle) : `about ${Math.round(med)}`} ms for ${held.length === 1 ? 'its' : 'their'} turn while no other island was hydrating and nothing on the first screen was still loading. ` +
					`Nothing on the page explains the wait: ogygia's scheduler held ${held.length === 1 ? 'it' : 'them'}.`,
				fix: 'This is ogygia’s own wait, not your code. Please report it with this page: the island names, their wake, and whether it happened on load or on a scroll.',
				fps: held.slice(0, 20).map((h) => h.r.fp)
			});
		}
	}

	// ── slow module loads ──
	const slow = rows.filter((r) => r.load_ms >= SLOW_LOAD_MS);
	const compiled = slow.filter((r) => dev_compile_ms(page, r) >= r.load_ms * 0.5);
	if (slow.length)
		findings.push({
			code: 'slow-module',
			severity: 'info',
			message:
				`${list(slow.map((r) => `${r.name} (${r.load_ms} ms)`))} waited a long time for its code to arrive.` +
				(compiled.length ? ` ${compiled.length === slow.length ? 'Most of the wait' : `For ${list(compiled.map((r) => r.name))}, most of it`} was the dev server compiling the files on this first request: reload for a warm reading.` : ''),
			fix: 'Check the island\'s imports in the Bytes tab: a big dependency, or a chain of imports loaded one after another. (Dev serves modules one by one; a build is faster.)',
			fps: slow.map((r) => r.fp)
		});

	// ── eager islands below the fold ──
	// (one that draws nothing here is nowhere on the page: its own finding below)
	const eager_below = regions.filter((r) => r.kind === 'island' && EAGER.has(r.wake) && !r.hidden && vh && typeof r.top === 'number' && r.top >= vh);
	if (eager_below.length) {
		// (copies of one island are one set of files: its own bytes once)
		const own = new Map<string, number>();
		for (const r of eager_below) if (r.own_bytes) own.set(r.name, r.own_bytes);
		const own_total = [...own.values()].reduce((s, n) => s + n, 0);
		const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
		// (by island, not copy: two copies of one island read as one name)
		const one = new Set(eager_below.map((r) => r.name)).size === 1;
		findings.push({
			code: 'eager-offscreen',
			// (its own code a big share of the first load: a warning past 50 KB moved off it)
			severity: own_total >= EAGER_BELOW_WARN ? 'warn' : 'info',
			message:
				`${list(eager_below.map((r) => r.name))} start${one ? 's' : ''} below the first screen but load${one ? 's' : ''} code at page load.` +
				(!own_total
					? ''
					: own_total < EAGER_BELOW_SMALL
						? ` Only ${kb(own_total)} of it is ${one ? 'its own' : 'theirs alone'} (the rest other islands load too): a later wake saves ${one ? 'its' : 'their'} hydration on the first load more than bytes.`
						: ` ${kb(own_total)} of it ${one ? 'is its own' : 'is theirs alone'} (no other island loads it): that much leaves the first load with a later wake.`),
			fix: "Use wake='visible': its code loads when it scrolls into view, and the islands on the first screen wake sooner.",
			fps: eager_below.map((r) => r.fp)
		});
	}

	// ── eager islands that draw nothing on this screen ──
	// (a mobile bar on a wide screen, a desktop sidebar on a phone: its code loads, and it shows nothing)
	// (not one that failed: it draws nothing because it broke, and its failure says so)
	const broke = new Set(failures.map((f) => f.fp));
	// (nor a headless one — only `hidden` markers: it is there for its effects, no screen shows it;
	// below, its weight when that is the news)
	const eager_hidden = regions.filter((r) => r.kind === 'island' && EAGER.has(r.wake) && r.hidden && !r.headless && !broke.has(r.fp));
	// ── a headless island whose own code is no small thing ──
	const headless = regions.filter((r) => r.kind === 'island' && EAGER.has(r.wake) && r.headless && !broke.has(r.fp) && (r.own_bytes ?? 0) >= EAGER_BELOW_SMALL);
	if (headless.length) {
		const own = new Map<string, number>();
		for (const r of headless) own.set(r.name, r.own_bytes!);
		const names = [...own.keys()];
		const one = names.length === 1;
		const total = [...own.values()].reduce((s, n) => s + n, 0);
		const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
		findings.push({
			code: 'headless-island',
			severity: total >= EAGER_BELOW_WARN ? 'warn' : 'info',
			message: `${list(names.map((n) => `${n} (${kb(own.get(n)!)} of its own)`))} render${one ? 's' : ''} nothing to see — only hidden markers — and load${one ? 's' : ''} ${one ? 'its' : 'their'} code at page load to run ${one ? 'its' : 'their'} effects.`,
			fix: `Worth it if the effects must run at start. Otherwise ${headless.some((r) => r.wake === 'load') ? "run them later (`wake: 'idle'`, after the page settles), or " : ''}move them into an island the visitor touches, where they load with it.`,
			fps: headless.map((r) => r.fp)
		});
	}
	if (eager_hidden.length) {
		const names = [...new Set(eager_hidden.map((r) => r.name))];
		const one = names.length === 1;
		// each island by what the sheets say: the query that shows it, or nothing readable
		const query_of = new Map<string, string>();
		for (const r of eager_hidden) if (r.shows_at && !query_of.has(r.name)) query_of.set(r.name, r.shows_at);
		const shown = names.filter((n) => query_of.has(n));
		const unknown = names.filter((n) => !query_of.has(n));
		const own = new Map<string, number>();
		for (const r of eager_hidden) if (r.own_bytes) own.set(r.name, r.own_bytes);
		const own_total = [...own.values()].reduce((s, n) => s + n, 0);
		const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
		const shows = shown.length ? [one ? `the page's CSS shows it only at ${query_of.get(shown[0])}` : `the page's CSS shows ${shown.map((n) => `${n} only at ${query_of.get(n)}`).join(', ')}`] : [];
		const bare = unknown.length ? (one ? 'no box of its own, hidden by its CSS or empty' : `${list(unknown)} ${unknown.length === 1 ? 'has' : 'have'} no box of ${unknown.length === 1 ? 'its' : 'their'} own (hidden by CSS, or empty)`) : '';
		const first_q = shown.length ? query_of.get(shown[0])! : '';
		findings.push({
			code: 'eager-hidden',
			severity: own_total >= EAGER_BELOW_WARN ? 'warn' : 'info',
			message:
				`${list(names)} draw${one ? 's' : ''} nothing on this screen (${vw ? `${vw} px wide` : 'this size'}) but load${one ? 's' : ''} ${one ? 'its' : 'their'} code at page load: ` +
				`${[...shows, ...(bare ? [bare] : [])].join('; ')}.` +
				(own_total ? ` ${kb(own_total)} of that code ${one ? 'is its own' : 'is theirs alone'}.` : ''),
			fix:
				(shown.length === 1
					? `Wake ${one ? 'it' : shown[0]} by that media query (\`with { wake: '${first_q}' }\`): the code loads only on the screens that show it, and wakes there as the screen changes.`
					: shown.length
						? `Wake each by its media query (${shown.map((n) => `${n}: \`with { wake: '${query_of.get(n)}' }\``).join(', ')}): the code loads only on the screens that show them, and wakes there as the screen changes.`
						: '') +
				(unknown.length
					? `${shown.length ? ` For ${list(unknown)}: if` : 'If'} it shows only on some screens, wake it by a media query (\`with { wake: '(max-width: …)' }\`); if it opens on a click, \`wake: 'interaction'\`.`
					: ''),
			fps: eager_hidden.map((r) => r.fp)
		});
	}

	// ── looked ready long before it worked ──
	const lcp = page.visit?.paints?.lcp ?? page.vitals.lcp;
	if (typeof lcp === 'number') {
		const late = rows.filter((r) => EAGER.has(r.wake) && !r.below_fold && r.done - lcp >= LATE_MS);
		// (on the dev server, the gap that is its code compiling on this first request is the dev
		// server's: late only for that reason, it is a note — a reload reads it warm)
		const compiling = late.filter((r) => r.done - lcp - dev_compile_ms(page, r) < LATE_MS);
		if (late.length)
			findings.push({
				code: 'late-interactive',
				severity: compiling.length === late.length ? 'info' : 'warn',
				message:
					`${list(late.map((r) => `${r.name} (${Math.round(r.done - lcp)} ms)`))} on the first screen woke long after the page looked finished (LCP ${Math.round(lcp)} ms). A visitor can click it and get nothing in that gap.` +
					(compiling.length ? ` ${compiling.length === late.length ? 'Most of the gap' : `For ${list(compiling.map((r) => r.name))}, most of it`} was the dev server compiling its code on this first request: reload for a warm reading.` : ''),
				fix: 'Shrink what it loads and what hydrates before it, or render it as plain HTML (a lake) if it does not need to be interactive at once.',
				fps: late.map((r) => r.fp)
			});
		// the largest paint sat in an island that rendered it again on hydration: the LCP repaints.
		// Proven by the island being rebuilt, by its element being taken out while the island stayed,
		// or by the largest paint landing after the island woke (the browser counted the new one) —
		// a changed attribute elsewhere in it (a tracking id) repaints nothing
		const lcp_fp = page.visit?.paints?.lcp_fp;
		const hit = lcp_fp ? rows.find((r) => r.fp === lcp_fp) : undefined;
		if (hit && (hit.recovered || (hit.changed && (page.visit?.paints?.lcp_replaced || lcp >= hit.done))))
			findings.push({
				code: 'lcp-repaint',
				severity: 'warn',
				message: `The largest paint (${page.visit?.paints?.lcp_tag ?? 'element'}) is inside ${hit.name}, which changed its markup on hydration — the biggest thing on screen repaints as it wakes.`,
				fix: 'Make the island render the same markup on both sides (see the markup finding), or keep the hero out of the island.',
				fps: [hit.fp]
			});
	}

	// ── the largest paint marked loading="lazy": the browser holds its fetch until layout says it
	// is on screen, behind every other image — a mistake on any page, fast or slow (a fast page only
	// hides it) ──
	const lp = page.visit?.paints;
	if (lp?.lcp_lazy) {
		const file = lp.lcp_url ? lp.lcp_url.slice(lp.lcp_url.lastIndexOf('/') + 1).split('?')[0] : '';
		findings.push({
			code: 'lcp-lazy',
			severity: 'warn',
			message: `The largest paint (${lp.lcp_tag ?? 'img'}${file ? ` ${file}` : ''}${lp.lcp_fp ? ` in ${by_fp.get(lp.lcp_fp)?.name ?? lp.lcp_fp.slice(0, 8)}` : ''}) carries loading="lazy": the browser waits to fetch it until layout says it is on screen, and puts it behind the page's other downloads.`,
			fix: 'Drop `loading="lazy"` on images of the first screen (keep it for the ones below), and give the hero `fetchpriority="high"`.',
			fps: lp.lcp_fp ? [lp.lcp_fp] : []
		});
	}

	// ── text kept invisible by its web font: a face with font-display auto/block (the default) hides
	// its text until the file arrives — up to 3 s — when the file lands after the first paint ──
	const fcp_at = page.visit?.paints?.fcp ?? page.vitals.fcp;
	const faces = page.visit?.font_faces;
	if (faces?.length && typeof fcp_at === 'number') {
		const late: { family: string; display: string; after: number; file: string }[] = [];
		for (const r of page.visit?.resources ?? []) {
			if (r.type !== 'font' || r.end - fcp_at < 100) continue;
			const face = faces.find((f) => f.urls.includes(r.url));
			if (!face || (face.display !== 'auto' && face.display !== 'block')) continue;
			if (late.some((l) => l.family === face.family)) continue;
			late.push({ family: face.family, display: face.display, after: Math.round(r.end - fcp_at), file: r.url.slice(r.url.lastIndexOf('/') + 1).split('?')[0] });
		}
		if (late.length)
			findings.push({
				code: 'font-invisible',
				severity: 'warn',
				message: `Text in ${list(late.map((l) => `'${l.family}' (${l.file}, ${l.after} ms after the first paint)`))} stayed invisible until its font arrived: font-display is ${late[0].display}, so the browser hides the text, up to 3 s, rather than show a fallback.`,
				fix: 'Give the @font-face `font-display: swap` (the text shows in a fallback at once, then switches) or `optional` (no switch, no shift), and preload the font file the first screen needs.',
				fps: []
			});
	}

	// ── images sent far bigger than shown: the bytes past what the box shows are bytes nobody sees ──
	const big = (page.visit?.images_oversized ?? [])
		.map((i) => ({ ...i, waste: Math.round(i.bytes * (1 - (i.shown[0] * i.shown[1] * i.dpr * i.dpr) / (i.natural[0] * i.natural[1]))) }))
		.sort((a, b) => b.waste - a.waste);
	const big_waste = big.reduce((n, i) => n + i.waste, 0);
	if (big.length && big_waste >= 50_000) {
		const kb = (n: number) => `${Math.round(n / 1024)} KB`;
		const file = (u: string) => u.slice(u.lastIndexOf('/') + 1).split('?')[0] || u;
		const named = big.slice(0, 3).map((i) => `${file(i.url)} (${i.natural[0]}×${i.natural[1]}, shown at ${i.shown[0]}×${i.shown[1]}${i.dpr !== 1 ? ` on a ${i.dpr}× screen` : ''}${i.fp ? ` in ${name_of(i.fp)}` : ''})`);
		findings.push({
			code: 'image-oversized',
			severity: 'warn',
			message: `${list(big.length > 3 ? [...named, `${big.length - 3} more`] : named)} ${big.length === 1 ? 'is' : 'are'} sent far bigger than shown: about ${kb(big_waste)} of ${kb(big.reduce((n, i) => n + i.bytes, 0))} is pixels nobody sees.`,
			fix: 'Serve each image near the size it shows at: a `srcset` with a few widths and a `sizes` that says how wide it shows (the browser picks the smallest that is sharp), or resize the file itself.',
			fps: [...new Set(big.flatMap((i) => (i.fp ? [i.fp] : [])))]
		});
	}

	// ── scrolling stalled: long frames while the page scrolled — the visitor's scroll waited on them ──
	const jank = page.visit?.scroll_jank ?? [];
	const jank_ms = jank.reduce((n, j) => n + j.ms, 0);
	const worst = jank.reduce((m, j) => Math.max(m, j.ms), 0);
	if (jank.length && (worst >= 100 || jank_ms >= 200)) {
		const file = (u: string) => {
			const q = u.indexOf('?');
			const p = q === -1 ? u : u.slice(0, q);
			return p.slice(p.lastIndexOf('/') + 1) || 'an inline script';
		};
		// the script that held the frames most, by its file, its function and what ran it
		const by = new Map<string, { label: string; ms: number }>();
		for (const j of jank)
			for (const s of j.scripts) {
				// (a minified one- or two-letter name says nothing: the island, or the file, instead)
				const fn = s.fn.length > 2 ? s.fn : '';
				const where = s.island ? `${s.island}'s code` : file(s.url);
				const label = `${fn ? `${fn} (${where})` : where}${s.invoker ? `, run by ${s.invoker}` : ''}`;
				const e = by.get(label);
				if (e) e.ms += s.ms;
				else by.set(label, { label, ms: s.ms });
			}
		const top = [...by.values()].sort((a, b) => b.ms - a.ms)[0];
		findings.push({
			code: 'scroll-jank',
			severity: 'warn',
			message: `Scrolling stalled: ${jank.length} frame${jank.length === 1 ? '' : 's'} took ${jank.length === 1 ? `${Math.round(worst)} ms` : `up to ${Math.round(worst)} ms (${Math.round(jank_ms)} ms in all)`} while the page scrolled${top ? `, mostly ${top.label} (${Math.round(top.ms)} ms)` : ''}: the page could not follow the visitor's scroll.`,
			fix: 'Do little in a scroll handler: mark it passive, do the work once per frame (requestAnimationFrame), or watch with an IntersectionObserver instead of measuring on every scroll event.',
			fps: []
		});
	}

	// ── forced layout: a script read sizes after changing the page, so the browser laid it out again
	// inside the task. An island's hydration runs in the runtime's own task: the island whose hydrate
	// window overlaps the script most is the one named ──
	const forced = page.visit?.forced_layout ?? [];
	if (forced.length) {
		const file = (u: string) => {
			const q = u.indexOf('?');
			const p = q === -1 ? u : u.slice(0, q);
			return p.slice(p.lastIndexOf('/') + 1) || 'an inline script';
		};
		const groups = new Map<string, { label: string; fp?: string; ms: number; n: number }>();
		for (const f of forced) {
			let best: PageIsland | undefined;
			let best_overlap = 0;
			for (const i of page.islands) {
				const from = i.turn ?? i.loaded;
				const overlap = Math.min(work_end(i), f.end) - Math.max(from, f.start);
				if (overlap > best_overlap) (best_overlap = overlap), (best = i);
			}
			const key = best ? best.fp : `${f.url}\0${f.fn}`;
			const label = best ? `${name_of(best.fp, best.entry)} while it hydrated` : `${file(f.url)}${f.fn ? ` (${f.fn})` : ''}`;
			const g = groups.get(key);
			if (g) (g.ms += f.ms), g.n++;
			else groups.set(key, { label, ...(best ? { fp: best.fp } : {}), ms: f.ms, n: 1 });
		}
		const top = [...groups.values()].filter((g) => g.ms >= 30).sort((a, b) => b.ms - a.ms);
		if (top.length)
			findings.push({
				code: 'forced-layout',
				severity: 'warn',
				// (an island's: where in it the CPU trace saw the time, when one was taken)
				message: `${list(top.slice(0, 3).map((g) => `${g.label} (${Math.round(g.ms)} ms${g.fp ? why_cpu(g.fp) : ''})`))} made the browser recalculate style and layout in the middle of running: the code read sizes or positions (offsetWidth, getBoundingClientRect, getComputedStyle) after changing the page, so each read laid the page out again.`,
				fix: 'Read every size first, then make every change (or put the changes in one requestAnimationFrame); never read layout between DOM writes in a loop. Sizes CSS can handle (width from the content, a fixed aspect ratio) need no read at all.',
				fps: top.flatMap((g) => (g.fp ? [g.fp] : []))
			});
	}

	// ── images far below the first screen that loaded at start: their bytes competed with the
	// first screen's ──
	const below = page.visit?.images_eager_below ?? [];
	const below_bytes = below.reduce((n, i) => n + i.bytes, 0);
	if (below.length && below_bytes >= 100_000) {
		const kb = (n: number) => `${Math.round(n / 1024)} KB`;
		const file = (u: string) => u.slice(u.lastIndexOf('/') + 1).split('?')[0] || u;
		const vh = page.visit?.viewport?.[1];
		// (one file name several times — the same image with other queries, a grid of copies — said once, ×N)
		const by_file = new Map<string, { n: number; bytes: number; top: number; fp?: string }>();
		for (const i of below) {
			const g = by_file.get(file(i.url));
			if (g) (g.n++, (g.bytes += i.bytes), (g.top = Math.min(g.top, i.top)));
			else by_file.set(file(i.url), { n: 1, bytes: i.bytes, top: i.top, ...(i.fp ? { fp: i.fp } : {}) });
		}
		const groups = [...by_file].sort((a, b) => b[1].bytes - a[1].bytes);
		const named = groups.slice(0, 3).map(([f, g]) => `${f}${g.n > 1 ? ` ×${g.n}` : ''} (${kb(g.bytes)}, ${vh ? `${(g.top / vh).toFixed(1)} screens` : `${g.top}px`} down${g.fp ? `, in ${name_of(g.fp)}` : ''})`);
		findings.push({
			code: 'images-eager-below',
			severity: 'warn',
			message: `${list(groups.length > 3 ? [...named, `${groups.length - 3} more`] : named)} ${below.length === 1 ? 'loads' : 'load'} at start though far below the first screen: ${kb(below_bytes)} that competed with the first screen's files for the network.`,
			fix: 'Give images below the first screen `loading="lazy"` (and their width and height, so nothing shifts when they arrive): the browser fetches them as the visitor scrolls near.',
			fps: [...new Set(below.flatMap((i) => (i.fp ? [i.fp] : [])))]
		});
	}

	// ── images the browser could hold no room for: the page below moved when each arrived ──
	const unsized = page.visit?.images_unsized ?? [];
	if (unsized.length) {
		const file = (u: string) => u.slice(u.lastIndexOf('/') + 1).split('?')[0] || u;
		const names = [...new Set(unsized.map(file))];
		const cls = page.vitals.cls;
		const moved = typeof cls === 'number' && cls >= 0.1;
		findings.push({
			code: 'img-unsized',
			severity: moved ? 'warn' : 'info',
			message: `${names.length === 1 ? `${names[0]} has` : `${list(names.slice(0, 4))}${names.length > 4 ? ` and ${names.length - 4} more` : ''} have`} no size the browser knows before the file comes (no width and height, no CSS aspect-ratio), so what is below moves when it arrives${moved ? ` — and this page moved (CLS ${Math.round(cls * 100) / 100})` : ' (unless CSS sets its height)'}.`,
			fix: 'Give each `<img>` its width and height attributes (the file’s own; CSS can still scale it), or a CSS aspect-ratio: the browser then holds the room from the first paint.',
			fps: []
		});
	}

	// ── a page of many elements: each costs memory, style and layout work, and an island hydrates
	// over every one of its own ──
	const dom = page.visit?.dom;
	if (dom && dom.nodes >= DOM_LARGE) {
		const top = dom.islands[0];
		const held = top && top.nodes >= dom.nodes * 0.3 ? top : undefined;
		const n = (x: number) => x.toLocaleString('en-US');
		findings.push({
			code: 'dom-large',
			severity: 'warn',
			message:
				`The page has ${n(dom.nodes)} elements${dom.depth ? ` (nested ${dom.depth} deep; the most children, ${n(dom.widest.children)}, under ${dom.widest.at})` : ''}` +
				(held
					? `, ${n(held.nodes)} of them inside ${name_of(held.fp)}: an island hydrates over every element of its own, so it pays for all of them as it wakes.`
					: ': every element costs memory and style and layout work on each change.'),
			fix: held
				? `Render fewer at once in ${name_of(held.fp)}: page or window a long list (only what is on screen), and keep big static markup outside the island (a lake costs nothing to hydrate).`
				: 'Render fewer at once: page or window long lists (only what is on screen), and flatten markup that nests wrappers for layout alone.',
			fps: held ? [held.fp] : []
		});
	}

	// ── a wake-at-load island that never woke ──
	const load_end = page.visit?.nav?.load ?? 0;
	if (load_end && now - load_end >= NEVER_MS) {
		const failed = new Set(failures.map((f) => f.fp));
		const asleep = regions.filter((r) => r.kind === 'island' && r.wake === 'load' && !r.hydrated && !failed.has(r.fp));
		if (asleep.length)
			findings.push({
				code: 'never-woke',
				severity: 'warn',
				message: `${list(asleep.map((r) => r.name))} should have woken at load but ${asleep.length === 1 ? 'is' : 'are'} still asleep ${Math.round((now - load_end) / 1000)} s later.`,
				fix: 'Look in the console for a module that never loaded, or an island nested in one that has not woken (it wakes with its parent).',
				fps: asleep.map((r) => r.fp)
			});
	}

	// ── the vitals themselves ──
	for (const v of vitals) {
		if (v.rating === 'good') continue;
		const head = `${v.label} is ${v.key === 'cls' ? v.value : `${Math.round(v.value)} ms`} (${v.rating === 'poor' ? 'poor' : 'needs work'}; good is ${v.key === 'cls' ? '≤ ' + LIMITS[v.key][0] : '≤ ' + LIMITS[v.key][0] + ' ms'}).`;
		const why =
			v.key === 'inp'
				? explain_interaction(page.visit?.interaction, rows, name_of, page.visit?.origin, page.interaction_cpu)
				: v.key === 'lcp'
					? explain_lcp(page, name_of)
					: v.key === 'cls'
						? explain_cls(page, rows, name_of)
						: v.key === 'ttfb'
							? explain_ttfb(page)
							: v.key === 'fcp'
								? explain_fcp(page)
								: null;
		// (the slowest interaction, the largest paint and the worst shifts, explained, are their own
		// findings in place of the bare vital: the profiler words the vitals from all its visits, and
		// keeps this visit's why)
		findings.push({
			code: why ? (v.key === 'inp' ? 'slow-interaction' : v.key === 'lcp' ? 'slow-lcp' : v.key === 'ttfb' ? 'slow-ttfb' : v.key === 'fcp' ? 'slow-fcp' : 'shift-cause') : `vital-${v.key}`,
			// (a why that is the dev server's own cost — a page compiling on its first request — is a note)
			severity: why && 'note' in why && why.note ? 'info' : v.rating === 'poor' ? 'warn' : 'info',
			message: why ? `${head} ${why.message}` : head,
			...(why ? { fix: why.fix } : {}),
			fps: v.key === 'lcp' && page.visit?.paints?.lcp_fp ? [page.visit.paints.lcp_fp] : why?.fps ?? [],
			// (the page compiling on its first request: the first byte's note only — a dev CSS shift is not a compile)
			// (the dev server's own doing: its first compile held the first byte, or the CSS it adds with
			// JavaScript moved the page — a reload reads it differently, never a change of the code)
			...((v.key === 'ttfb' || v.key === 'cls') && why && 'note' in why && why.note ? { dev_compile: true as const } : {})
		});
	}

	// ── resources: what blocked the first paint, and the bytes by type ──
	const fcp = page.visit?.paints?.fcp ?? page.vitals.fcp ?? Infinity;
	const blocking = (page.visit?.resources ?? [])
		.filter((r) => r.blocking && r.start < fcp)
		.map((r) => ({ url: r.url, ms: round(r.end - r.start), bytes: r.transfer ?? r.size ?? 0 }))
		.sort((a, b) => b.ms - a.ms);
	// what they cost: how long after the HTML arrived the last blocking file was in (the paint could
	// not come sooner) — many small files that land at once cost nothing worth a finding
	const html_at = page.visit?.nav?.res_start ?? 0;
	let blocked_until = 0;
	for (const r of page.visit?.resources ?? []) if (r.blocking && r.start < fcp) blocked_until = Math.max(blocked_until, r.end);
	const held_ms = blocking.length ? Math.max(0, blocked_until - html_at) : 0;
	// (the first paint's own explanation already names that file as what it waited on: one card,
	// at the louder of the two severities — not the same cause told twice)
	const fcp_card = held_ms >= 200 ? findings.find((f) => f.code === 'slow-fcp' && f.message.includes('waiting for') && f.message.includes(short(blocking[0].url))) : undefined;
	// THE ONE NUMBER (a build): the inlineStyleThreshold that takes the small sheets off the paint,
	// the profiler's own reckoning over the sheets this browser waited on
	const tune = held_ms >= 200 ? inline_threshold_tune((page.visit?.resources ?? []).filter((r) => r.blocking && r.start < fcp).map((r) => ({ url: r.url, kind: r.type, bytes: r.size ?? 0 }))) : null;
	const tune_text = tune ? `With \`kit: { inlineStyleThreshold: ${tune.threshold} }\` in svelte.config.js, ${tune.files} of these stylesheets (${(tune.bytes / 1024).toFixed(1)} KB) arrive inside the HTML: ${blocking.length - tune.files} file${blocking.length - tune.files === 1 ? '' : 's'} left to wait on instead of ${blocking.length}.` : '';
	if (fcp_card) {
		if (held_ms >= 600) fcp_card.severity = 'warn';
		if (tune_text) fcp_card.fix = `${fcp_card.fix ?? ''} ${tune_text}`.trim();
	} else if (held_ms >= 200)
		findings.push({
			code: 'render-blocking',
			severity: held_ms >= 600 ? 'warn' : 'info',
			message: `${blocking.length} file${blocking.length === 1 ? '' : 's'} blocked the first paint for ${Math.round(held_ms)} ms after the HTML arrived; the slowest took ${Math.round(blocking[0].ms)} ms (${short(blocking[0].url)}).`,
			fix: tune_text ? `${tune_text} Merge or trim the rest, and load scripts as modules (they do not block).` : 'Inline small stylesheets, merge the rest, and load scripts as modules (they do not block).',
			fps: []
		});
	const bytes_by = new Map<string, { type: string; count: number; transfer: number; size: number }>();
	// (all the files when the visit has their totals; the listed ones are only the first 200)
	if (page.visit?.resource_totals?.length) for (const t of page.visit.resource_totals) bytes_by.set(t.type, { ...t });
	else
		for (const r of page.visit?.resources ?? []) {
			const b = bytes_by.get(r.type) ?? { type: r.type, count: 0, transfer: 0, size: 0 };
			b.count++;
			b.transfer += r.transfer ?? 0;
			b.size += r.size ?? 0;
			bytes_by.set(r.type, b);
		}

	// ── long tasks outside any hydration ──
	let longtask_ms = 0;
	for (const t of page.longtasks) longtask_ms += t.ms;
	const in_hydration = rows.reduce((s, r) => s + r.longtask_ms, 0);
	const other = longtask_ms - in_hydration;
	if (other >= 150) {
		const biggest = page.longtasks.reduce((m, t) => (t.ms > m.ms ? t : m), page.longtasks[0]);
		findings.push({
			code: 'long-tasks',
			severity: 'info',
			message: `${Math.round(other)} ms of long tasks ran outside any island's hydration (the longest ${Math.round(biggest.ms)} ms at ${Math.round(biggest.t)} ms${why_cpu(null) || why_script()}). Page scripts, not islands, held the main thread.`,
			fix: 'Record a Performance trace around that time to see the script; third-party tags are the usual cause.',
			fps: []
		});
	}

	// ── Svelte's hydration warnings (dev): a disagreement Svelte papered over (it kept the server's
	// value) — nothing on screen shows it, the island may still behave on the browser's value ──
	const warns = page.visit?.warnings ?? [];
	if (warns.length) {
		const by = new Map<string, { code: string; file?: string; fps: Set<string>; n: number }>();
		for (const w of warns) {
			const key = `${w.code}|${w.file ?? ''}`;
			const g = by.get(key) ?? { code: w.code, file: w.file, fps: new Set<string>(), n: 0 };
			g.n++;
			if (w.fp) g.fps.add(w.fp);
			by.set(key, g);
		}
		const groups = [...by.values()];
		const fps = [...new Set(groups.flatMap((g) => [...g.fps]))];
		findings.push({
			code: 'svelte-hydration-warning',
			severity: 'warn',
			message: `Svelte warned while hydrating: ${groups
				.slice(0, 3)
				.map((g) => `${g.code}${g.file ? ` in ${short(g.file)}` : ''}${g.fps.size ? ` (${list([...g.fps].map((fp) => name_of(fp)))})` : ''}${g.n > 1 ? ` ×${g.n}` : ''}`)
				.join('; ')}. The server and the browser disagreed; Svelte kept the server's value, so the screen does not show it.`,
			fix: 'Make the value the same on both sides (a value only the server has belongs in props; time, random and browser-only reads belong in an effect).',
			fps
		});
	}

	// ── children the server never rendered: an island's children are the server's HTML, adopted as
	// they are; children behind a condition that was false on the server have no HTML to show ──
	const empty = [...new Set(page.empty_slots ?? [])];
	if (empty.length)
		findings.push({
			code: 'empty-slot',
			severity: 'warn',
			message: `${list(empty.map((fp) => name_of(fp)))} shows its children in a slot with nothing in it: an island's children are the server's HTML, so children the server did not render (a condition that was false there) cannot appear in the browser.`,
			fix: 'Render the children on the server and hide them (the hidden attribute, or CSS) instead of wrapping them in {#if}; or make the part that appears later its own island inside the component.',
			fps: empty
		});

	// ── an island's code: a barrel it still imports whole, one module most of its weight ──
	// (dev code is unbundled and unminified: shares and module names, not shipped bytes)
	const kb = (n: number) => `${Math.round(n / 1024)} KB`;
	for (const c of page.island_code ?? []) {
		const b = c.barrels[0];
		if (b)
			findings.push({
				code: 'island-barrel',
				severity: 'warn',
				message: `${c.name} still imports a barrel whole: ${b.file}, and the ${b.fanout} modules behind it ride into the island${c.barrels.length > 1 ? ` (and ${c.barrels.length - 1} more barrel${c.barrels.length > 2 ? 's' : ''})` : ''}. A Svelte component is never side-effect free to the bundler, so what the island does not use still ships.`,
				fix: `Import what the island uses from its own file, or turn on ogygia({ barrels }). If it is on, the build log names why this one was left ("barrels: skipped …").`,
				fps: c.fp ? [c.fp] : []
			});
		const big = c.top[0];
		if (big && c.bytes >= 30 * 1024 && big.bytes >= c.bytes * 0.4 && c.top.length > 1)
			findings.push({
				code: 'island-heavy-module',
				severity: 'info',
				message: `${big.file.split('/').pop()} is ${Math.round((big.bytes / c.bytes) * 100)}% of ${c.name}'s code (${kb(big.bytes)} of ${kb(c.bytes)} in dev).`,
				fix: 'That one module is where the island’s weight is: split it (one module per piece), load it when it is needed, or render it on the server.',
				fps: c.fp ? [c.fp] : []
			});
	}

	// ── a hole on the first screen whose answer came slowly: its fallback is what the visitor saw ──
	const slow_holes = (page.hole_waits ?? []).filter((h) => !h.below_fold && h.wait_ms >= SLOW_HOLE_MS).sort((a, b) => b.wait_ms - a.wait_ms);
	if (slow_holes.length) {
		const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
		const dur = (ms: number) => (ms >= 1000 ? secs(ms) : `${Math.round(ms)} ms`);
		// WHERE THE WAIT WENT. Before its request left (the gate, a busy page, a late wake), then the
		// server: its render when the profiler recorded it, else the browser's wait for the first byte
		const all = page.hole_waits ?? [];
		const split = (h: HoleWait) => {
			const shown = h.shown_at ?? -Infinity;
			const before = h.left_at !== undefined && h.shown_at !== undefined ? Math.max(0, h.left_at - shown) : undefined;
			const ttfb = h.first_at !== undefined && h.left_at !== undefined ? Math.max(0, h.first_at - Math.max(h.left_at, shown)) : undefined;
			// hole requests in flight as it left (or ending just then: the slot it took): the gate was full
			// (a batched hole took no slot: it rode one request with the others)
			const ahead =
				h.left_at === undefined || h.batch_size
					? 0
					: all.filter((o) => o !== h && o.left_at !== undefined && o.end_at !== undefined && o.left_at < h.left_at! && o.end_at >= h.left_at! - 50).length;
			return { before, queue: h.server_queue_ms, server: h.server_ms ?? ttfb, rendered: h.server_ms !== undefined, ahead };
		};
		const parts = (h: HoleWait) => {
			const s = split(h);
			const out: string[] = [];
			if (s.before !== undefined && s.before >= 200) out.push(`${dur(s.before)} before its request left`);
			if (s.queue !== undefined && s.queue >= 200) out.push(`${dur(s.queue)} waiting for a render slot on the server`);
			if (s.server !== undefined && s.server >= 50) out.push(`${dur(s.server)} ${s.rendered ? 'the server render' : 'waiting on the server'}`);
			// (its answer was one part of a batch: it landed when the server rendered it, not after the others)
			if (h.batch_size && h.batch_size > 1) out.push(`its part of one request for ${h.batch_size} holes`);
			return out.length ? `: ${out.join(', ')}` : '';
		};
		const splits = slow_holes.map(split);
		// the server's render slots were full: slow holes ahead held them while they awaited data
		const slotted = splits.every((s, i) => s.queue !== undefined && s.queue >= slow_holes[i].wait_ms * 0.4);
		const late = !slotted && splits.every((s, i) => s.before !== undefined && s.before >= slow_holes[i].wait_ms * 0.4);
		const gated = late && splits.some((s) => s.ahead >= HOLE_GATE);
		const known = splits.filter((s) => s.server !== undefined);
		const render_bound = !late && !slotted && known.length === splits.length && splits.every((s, i) => s.server! >= slow_holes[i].wait_ms * 0.6);
		const elsewhere = !late && !slotted && known.length === splits.length && splits.every((s, i) => s.server! < slow_holes[i].wait_ms * 0.4);
		const ahead = Math.max(...splits.map((s) => s.ahead));
		findings.push({
			code: 'hole-slow',
			severity: slow_holes[0].wait_ms >= SLOW_HOLE_MS * 1.5 ? 'warn' : 'info',
			message: `${list(slow_holes.map((h) => `${h.name} (${secs(h.wait_ms)}${parts(h)})`))} showed ${slow_holes.length === 1 ? 'its' : 'their'} fallback on the first screen that long before ${slow_holes.length === 1 ? 'its' : 'their'} answer came.`,
			fix: slotted
				? `It waited on the server for a render slot: a server process renders ${REGION_RENDER_CONCURRENCY} holes at a time, and each holds its slot while it awaits its data, so slow holes make the next one wait (every visitor’s, on that process). Make the slow holes answer sooner (a maxAge, faster data), or put fewer of them on one page. The Server-Timing on its answer has the split.`
				: gated
				? `It waited for its turn: the runtime runs ${HOLE_GATE} hole requests at a time, and ${ahead} were ahead of it. Put fewer holes on the first screen (render the ones that are the same for every visitor with the page, or merge small ones into one), or make the ones ahead answer sooner (a maxAge).`
				: late
					? 'Its request left late: the page was busy (long tasks) when it was due, or the hole woke late. The long tasks and the wake order on this tab show which.'
					: render_bound
						? `${splits.every((s) => s.rendered) ? 'The server render' : 'The server'} is the wait: give the hole a maxAge if its answer is the same for a while, start its data sooner (or in parallel), or render it with the page if it is the same for every visitor.`
						: elsewhere
							? splits.every((s) => s.before !== undefined)
								? 'The server answered quickly and the request left on time: the wait came after the first byte (a large answer, its styles, or the swap) or on the network.'
								: 'The server answered quickly: the wait came before or around the request. Its request started late (the page was busy, or the hole woke late), or the network or something in front of the server held it. The report’s One clock section shows when it left.'
							: 'The hole’s server render or its data is slow: give it a maxAge if its answer is the same for a while, start its data sooner, or render it with the page if it is the same for every visitor. The profiler’s Holes section has its server time.',
			fps: []
		});
	}

	// ── an island whose fingerprint moved between two loads of the same page ──
	const drift = page.fp_drift ?? [];
	if (drift.length) {
		const first = drift[0];
		const whose = (d: (typeof drift)[number]) => (drift.length === 1 ? 'its' : `${d.name}'s`);
		const said = (d: (typeof drift)[number]) =>
			d.path ? `${whose(d)} prop \`${d.path}\` was ${d.was}, now ${d.now}` : d.was !== undefined ? `${whose(d)} props went from …${d.was}… to …${d.now}…` : `${whose(d)} props changed`;
		findings.push({
			code: 'fp-unstable',
			severity: 'info',
			message: `${list(drift.map((d) => d.name))} got a new fingerprint since your last load of this page: ${said(first)}${drift.length > 1 ? ` (and ${drift.length - 1} more)` : ''}. If the page's data did not change, that value is made fresh on every render.`,
			fix: 'The router compares fingerprints to keep a live island across a navigation, and the fingerprint is part of the page’s bytes: an island whose props change on every render is patched on every navigation, and a cache keyed on the HTML (a CDN, a post-render cache, a freeze store, an ETag) misses every time. Make the value the same for the same inputs: take it from load data, compute it in the browser (an effect), or leave it out of the props.',
			fps: drift.map((d) => d.fp).filter((x): x is string => !!x)
		});
	}

	// ── what an island left running after it left the page ──
	for (const l of page.leftovers ?? []) {
		const what: string[] = [];
		if (l.intervals) what.push(l.intervals === 1 ? 'an interval running' : `${l.intervals} intervals running`);
		if (l.listeners.length) what.push(l.listeners.length === 1 ? `a ${l.listeners[0]} listener attached` : `${l.listeners.length} listeners attached (${counted(l.listeners)})`);
		const ran = l.intervals ? ` (still running: ${l.fires} run${l.fires === 1 ? '' : 's'} so far${l.last_ago !== undefined ? `, the last ${l.last_ago < 1000 ? `${l.last_ago} ms` : `${(l.last_ago / 1000).toFixed(1)} s`} ago` : ''})` : '';
		findings.push({
			code: 'island-leftover',
			severity: 'warn',
			message: `${l.name} left ${list(what)} after it left the page${ran}. Each visit to its page adds another, and each keeps the island's state in memory.`,
			fix: 'Take back what the island starts when it goes: return a cleanup from the `$effect` that started it (`clearInterval(id)`, `removeEventListener` with the same function and capture), or pass an AbortSignal and abort it there. The router keeps the document across navigations, so nothing a page left behind is cleared by the next page.',
			fps: []
		});
	}

	// ── kept out of the back/forward cache: Back reloads the page from the server ──
	const bf = page.bfcache;
	// (the server's own answer, which the browser cannot read: the profiler's last run of this page saw it)
	const ns = page.server_profile?.no_store;
	if ((bf && (bf.unload.length || bf.not_restored?.length)) || ns) {
		const unload = bf?.unload ?? [];
		findings.push({
			code: 'bfcache-blocked',
			severity: 'warn',
			message:
				(unload.length
					? `${list(unload)} ${unload.length === 1 ? 'adds' : 'add'} an 'unload' listener: the browser keeps no page with one in its back/forward cache, so Back and Forward load this page from the server again instead of showing it at once.`
					: ns
						? `The page answers with Cache-Control: ${ns} (the profiler's last run of it saw so): the browser keeps no page marked no-store in its back/forward cache, so Back and Forward load it from the server again instead of showing it at once.`
						: 'This load came from Back or Forward, and the browser did not restore the page from its back/forward cache: it loaded from the server again.') +
				(unload.length && ns ? ` It also answers with Cache-Control: ${ns}, which keeps it out too.` : '') +
				(bf?.not_restored?.length ? ` The browser's reasons for this load: ${bf.not_restored.join(', ')}.` : ''),
			fix: "Listen to 'pagehide' (or 'visibilitychange') instead of 'unload': it runs at the same moment and keeps the cache. A `Cache-Control: no-store` on the page keeps it out too.",
			fps: []
		});
	}

	// ── listeners that hold scrolling: the browser waits for each before it scrolls ──
	const blockers = page.scroll_blockers ?? [];
	if (blockers.length) {
		const said = [...new Set(blockers.map((b) => `${b.owner}'s '${b.type}' listener on ${b.on}${b.forced ? ' (passive: false)' : ''}`))];
		findings.push({
			code: 'scroll-blocking',
			severity: 'warn',
			message: `${list(said.slice(0, 3))}${said.length > 3 ? ` and ${said.length - 3} more` : ''} ${said.length === 1 ? 'holds' : 'hold'} scrolling: the browser must run ${said.length === 1 ? 'it' : 'each'} before it moves the page (it might call preventDefault), on every wheel turn or touch move, and a busy main thread then makes scrolling stutter.`,
			fix: 'Add `{ passive: true }` when the listener never calls preventDefault. To stop scrolling, use CSS instead (`overscroll-behavior`, `touch-action`), so the browser can scroll without asking.',
			fps: []
		});
	}

	// ── a server transform's restore that went wrong (runtime/restore.ts) ──
	const late = (page.restore_events ?? []).filter((e) => e.kind === 'late');
	if (late.length) {
		const islands = [...new Set(late.map((e) => e.island).filter((x): x is string => !!x))];
		const names = islands.map((fp) => by_fp.get(fp)?.name ?? fp.slice(0, 8));
		findings.push({
			code: 'restore-late',
			severity: 'warn',
			message: `${counted(late.map((e) => `<${e.host}>`))} ${late.length === 1 ? 'was' : 'were'} upgraded by ${late.length === 1 ? 'its' : 'their'} component before ogygia restored ${late.length === 1 ? 'it' : 'them'}: ${late.length === 1 ? 'it keeps' : 'they keep'} the server render's scoped form${names.length ? `, and ${list(names)} ${names.length === 1 ? 'hydrates' : 'hydrate'} against that (expect a heal or a client re-render)` : ''}.`,
			fix: 'The component’s definition ran before ogygia’s restorer, which runs at the end of the body: a blocking <script> (no type=module, no defer) in the head, or before the host, defines it. Load the component library as a module or with defer — every module and deferred script runs after the restore.',
			fps: islands
		});
	}
	const broken = (page.restore_events ?? []).filter((e) => e.kind === 'mismatch');
	if (broken.length) {
		const islands = [...new Set(broken.map((e) => e.island).filter((x): x is string => !!x))];
		findings.push({
			code: 'restore-mismatch',
			severity: 'warn',
			message: `The server transform left ${counted(broken.map((e) => `<${e.host}>`))} different from what Svelte rendered, after ogygia restored it: ${clip(broken[0].diff ?? 'the children differ')}.`,
			fix: 'The transform changed Svelte-owned markup ogygia could not put back: a child it dropped, or moved out of the plan’s <slot> wrappers, or a text it rewrote with no mark. Keep Svelte’s children inside the slot wrappers as they came; the island inside will otherwise heal or render again in the browser.',
			fps: islands
		});
	}

	// ── a batch request that did not carry its holes: each then fetched on its own ──
	for (const b of page.hole_batches ?? []) {
		const missed = b.sent - b.delivered;
		if (missed <= 0) continue;
		const what =
			b.refused === 'redirected'
				? `was redirected${b.final_url ? ` to ${path_of(b.final_url)}` : ''}`
				: b.refused === 'document'
					? `was answered with a page${b.final_url ? ` (${path_of(b.final_url)})` : ''}, not the holes`
					: b.status === 0
						? 'failed (the request itself)'
						: b.status >= 400
							? `was answered ${b.status}`
							: `ended without ${missed === b.sent ? 'any of them' : `${missed} of them`}`;
		const front = b.refused !== undefined || b.status === 405 || b.status === 403 || b.status === 401 || b.status === 404;
		findings.push({
			code: 'hole-batch-missed',
			severity: missed === b.sent ? 'warn' : 'info',
			message: `The one request for ${b.sent} holes (${counted(b.names)}) ${what}: ${missed === b.sent ? 'every one' : `${missed}`} then fetched on its own — ${missed + 1} requests instead of 1, each starting only after the batch ended.`,
			fix: front
				? 'Something in front of ogygia.handle() took the batch: a handle (auth, locale, a method filter) or a firewall / CDN rule that allows only GET on the islands endpoint. Let POST through to it there — it is the same signed capabilities as each GET, verified the same way.'
				: 'The server could not render those holes in the batch (a render failed, or an answer was too large to box). Each hole’s own request then shows its error; the Network panel has the batch’s response.',
			fps: []
		});
	}

	// ── preloaded, then downloaded again: the preload did not match the request and went unused ──
	const misses = page.visit?.preload_misses ?? [];
	if (misses.length) {
		const file = (u: string) => {
			const q = u.indexOf('?');
			const p = q === -1 ? u : u.slice(0, q);
			return p.slice(p.lastIndexOf('/') + 1) || u;
		};
		const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
		const why = (m: PreloadMiss) =>
			m.type === 'font' && m.crossorigin === null
				? 'a font always loads in CORS mode: its preload needs `crossorigin`'
				: m.type === 'fetch' && m.crossorigin === null
					? 'a fetch preload needs `crossorigin` (`anonymous` for a same-origin `fetch()`, `use-credentials` for `credentials: "include"`)'
					: m.type === 'fetch' || m.type === 'font'
						? `its \`crossorigin="${m.crossorigin}"\` does not match the request's credentials`
						: m.type === 'script'
							? 'a module script is preloaded with `<link rel="modulepreload">`, not `rel="preload" as="script"`'
							: 'its `as` or `crossorigin` does not match how the page requests the file';
		const wasted = misses.reduce((a, m) => a + m.bytes, 0);
		findings.push({
			code: 'preload-unused',
			severity: 'warn',
			message: `${list(misses.map((m) => `${file(m.url)} (${kb(m.bytes)})`))} ${misses.length === 1 ? 'was' : 'were'} preloaded, then downloaded again: the browser could not use the preload${misses.length === 1 ? '' : 's'}, and the page paid ${kb(wasted)} twice.`,
			fix: `${[...new Set(misses.map(why))].map((w) => w[0].toUpperCase() + w.slice(1)).join('. ')}. The preload and the request must match exactly, or the browser fetches the file again.`,
			fps: []
		});
	}

	// ── preloaded, never used: nothing on the page uses the file 3 s after load ──
	const never = page.visit?.preloads_unused ?? [];
	if (never.length) {
		const file = (u: string) => {
			const q = u.indexOf('?');
			const p = q === -1 ? u : u.slice(0, q);
			return p.slice(p.lastIndexOf('/') + 1) || u;
		};
		const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
		const WHAT: Record<string, string> = { image: 'no image on the page shows it', font: 'no @font-face names it', style: 'no stylesheet link loads it' };
		findings.push({
			code: 'preload-never-used',
			severity: 'warn',
			message: `${list(never.map((p) => `${file(p.url)} (${p.as}${p.bytes ? `, ${kb(p.bytes)}` : ''}: ${WHAT[p.as] ?? 'nothing uses it'})`))} ${never.length === 1 ? 'was' : 'were'} preloaded, but nothing on the page used ${never.length === 1 ? 'it' : 'them'} 3 s after load: the bytes competed with the files the first screen needed.`,
			fix: 'Remove the preload, or point it at the file the page really uses: the same URL the `<img>` or CSS asks for, the exact file the `@font-face` names.',
			fps: []
		});
	}

	// ── text sent uncompressed: the server (or a proxy before it) sent it without gzip or brotli ──
	// (the dev server sends everything as it is: only a build's server says something about the app)
	const raw_files = page.dev ? [] : (page.visit?.uncompressed ?? []);
	const raw_doc = !page.dev && page.visit?.nav?.raw ? (page.visit.nav.size ?? 0) : 0;
	const raw_total = raw_files.reduce((s, f) => s + f.bytes, 0) + raw_doc;
	if (raw_total >= UNCOMPRESSED_FINDING) {
		const file = (u: string) => {
			const q = u.indexOf('?');
			const p = q === -1 ? u : u.slice(0, q);
			return p.slice(p.lastIndexOf('/') + 1) || u;
		};
		const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
		const names = [...(raw_doc ? [`the page's HTML (${kb(raw_doc)})`] : []), ...raw_files.slice(0, 4).map((f) => `${file(f.url)} (${f.type}, ${kb(f.bytes)})`)];
		const more = raw_files.length - 4;
		findings.push({
			code: 'uncompressed',
			severity: raw_total >= UNCOMPRESSED_WARN ? 'warn' : 'info',
			message: `${list(names)}${more > 0 ? ` and ${more} more` : ''} came down uncompressed: ${kb(raw_total)} over the wire where gzip or brotli usually sends a quarter to a third of that. Every visitor on a slow connection waits for the difference.`,
			fix: 'Turn on compression where the response leaves your server: a compression middleware, the adapter\'s precompress option for built files, or the CDN\'s setting. A `Cache-Control: no-transform` on the response, or a proxy that strips `Accept-Encoding`, also keeps it off.',
			fps: []
		});
	}

	// ── an island's own file was gone: this page outlived its build (a cache kept the HTML) ──
	const gone = page.visit?.entry_fallbacks ?? [];
	if (gone.length) {
		const name = (f: (typeof gone)[number]) => {
			if (f.name) return f.name;
			const q = f.entry.indexOf('?');
			const p = q === -1 ? f.entry : f.entry.slice(0, q);
			return p.slice(p.lastIndexOf('/') + 1);
		};
		const woke = gone.filter((f) => f.recovered);
		const dead = gone.filter((f) => !f.recovered);
		const parts: string[] = [];
		if (woke.length)
			parts.push(
				`${list(woke.map(name))} woke on the current build's code through ${woke.length === 1 ? 'its' : 'their'} stable name${woke.length === 1 ? '' : 's'}: the page's HTML and ${woke.length === 1 ? 'that island' : 'those islands'} now come from different builds`
			);
		if (dead.length) parts.push(`${list(dead.map(name))} stayed asleep: ${dead.length === 1 ? 'its' : 'their'} stable name failed too`);
		findings.push({
			code: 'island-file-gone',
			severity: dead.length ? 'error' : 'warn',
			message: `${gone.length === 1 ? 'An island' : `${gone.length} islands`} could not load ${gone.length === 1 ? 'its own file' : 'their own files'} (${list(gone.map((f) => f.src.slice(f.src.lastIndexOf('/') + 1)))}): this page came from a cache that outlived the build that made it. ${parts.join('. ')}.`,
			fix: "Keep the previous build's `_app/immutable/` files as long as your HTML stays cached (a CDN, a service worker) — a cached page then runs its own build throughout — or purge the cached HTML when you deploy.",
			fps: []
		});
	}

	// ── a slow in-app navigation: the router's swap, split by where its time went ──
	const navs = page.visit?.navs ?? [];
	const slow_navs = navs
		.map((n, i) => ({ n, ms: n.swapped - n.t, next: navs[i + 1]?.t ?? Infinity }))
		.filter((x) => x.ms >= SLOW_NAV_MS)
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 3);
	for (const { n, ms, next } of slow_navs) {
		const fetch_ms = n.fetched - n.t;
		const styles_ms = n.styled - n.fetched;
		const swap_ms = n.swapped - n.styled;
		// what the new page woke after it showed (its islands, until the next navigation)
		const woke = page.islands.filter((i) => i.t0 >= n.t && i.t0 < next);
		const wake_end = woke.length ? Math.max(...woke.map(work_end)) : n.swapped;
		const heaviest = woke.map((i) => ({ name: name_of(i.fp), ms: work_end(i) - (i.turn ?? i.loaded) })).sort((a, b) => b.ms - a.ms)[0];
		// the fetch, split by the page request's own timing: the server's first byte, the download
		const kb_of = (b: number) => (b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
		const known = n.server !== undefined && n.download !== undefined;
		// (a prefetched page's request began before the click: how much earlier, from its own timing)
		const head_start = known && n.prefetched ? Math.max(0, n.server! + n.download! - fetch_ms) : 0;
		const fetch_text = n.prefetched
			? `${Math.round(fetch_ms)} ms still waiting for the page after the click (prefetched on hover${known ? ` ${Math.round(head_start)} ms earlier: the server took ${Math.round(n.server!)} ms to answer` : ''})`
			: `${Math.round(fetch_ms)} ms fetching the page from the server${known ? ` (${Math.round(n.server!)} ms waiting for its first byte, ${Math.round(n.download!)} ms downloading${n.bytes ? ` ${kb_of(n.bytes)}` : ''})` : ''}`;
		// a heavy page: its download, not the server's answer, is most of the fetch
		const heavy_page = known && n.download! > n.server!;
		const parts = [
			{ key: 'fetch', ms: fetch_ms, text: fetch_text },
			{ key: 'styles', ms: styles_ms, text: `${Math.round(styles_ms)} ms loading its stylesheets` },
			{ key: 'swap', ms: swap_ms, text: `${Math.round(swap_ms)} ms swapping it in` }
		];
		const top = parts.reduce((a, b) => (b.ms > a.ms ? b : a));
		// THE SERVER'S SIDE of the fetch (the profiler's request log): running code, outbound calls,
		// or waiting on something that is neither
		const srv = n.on_server;
		const srv_other = srv ? Math.max(0, srv.ms - srv.cpu_ms - srv.net_ms) : 0;
		const srv_top = !srv ? null : srv.cpu_ms >= srv.net_ms && srv.cpu_ms >= srv_other ? 'cpu' : srv.net_ms >= srv_other ? 'net' : 'other';
		const server_sentence = srv
			? ` On the server that page took ${srv.ms} ms: ${srv.cpu_ms} ms running code, ${srv.net_count ? `${srv.net_ms} ms waiting on ${srv.net_count} outbound call${srv.net_count === 1 ? '' : 's'}` : 'no outbound calls'}, and ${srv_other} ms waiting on something else${srv.inflight ? ` (${srv.inflight} other request${srv.inflight === 1 ? ' was' : 's were'} running: its CPU is shared)` : ''}.`
			: '';
		findings.push({
			code: 'slow-navigation',
			severity: ms >= SLOW_NAV_WARN_MS ? 'warn' : 'info',
			message:
				`The in-app navigation to ${n.to} took ${Math.round(ms)} ms before the new page showed: ${parts.map((p) => p.text).join(', ')}.` +
				(top.key === 'fetch' && !heavy_page ? server_sentence : '') +
				// (devtools: the profiler's last run of the page it went to, when its request log is not here)
				(top.key === 'fetch' && !heavy_page && !srv && page.server_profiles ? server_says(page.server_profiles[n.to.split('?')[0]]).replace('this page', 'that page') : '') +
				(woke.length ? ` Then ${woke.length === 1 ? 'its island woke' : `${woke.length} islands woke`} over ${Math.round(Math.max(0, wake_end - n.swapped))} ms${heaviest && heaviest.ms >= 20 ? ` (${heaviest.name} ${Math.round(heaviest.ms)} ms to hydrate)` : ''}.` : ''),
			fix:
				top.key === 'fetch' && heavy_page
					? `The page itself is the wait: ${n.bytes ? `${kb_of(n.bytes)} of HTML` : 'its HTML'} took longer to download than the server took to answer. Send less (render below-the-fold parts later, trim repeated markup and inline data), and make sure it is compressed.`
					: top.key === 'fetch' && srv_top === 'cpu'
					? "The server's own code is the wait: profile that page (its report names the slow load or component and the lines in it), and render less on it."
					: top.key === 'fetch' && srv_top === 'net'
					? "The page's outbound calls are the wait: run them in parallel instead of one after another, cache the ones that repeat, or move the slow one out of the page's load (stream it, or a hole)."
					: top.key === 'fetch' && srv_top === 'other'
					? "The server waited on something that is neither its code nor an outbound call it could see: a timer, a lock, a connection pool, a database driver that does not use fetch. Look at what that page's load awaits."
					: top.key === 'fetch'
					? "The server's answer is the wait: make that page's load faster (profile the page itself: its report names the slow load), or render it with less. The router starts the fetch at the click, so the server's time is the visitor's."
					: top.key === 'styles'
						? "Its stylesheets were not in the browser yet: the router waits for them so the page never shows unstyled. Share one stylesheet across pages, or keep each page's small, so the next page's are cached or quick."
						: 'The swap itself is heavy: a large page body to parse and put in, or many islands to reconcile. Send less HTML (render below-the-fold parts later), or split the page.',
			fps: []
		});
	}

	// ── content-named files fetched again: the host does not let the browser keep them ──
	const again = page.visit?.refetched ?? [];
	if (again.length) {
		const name = (f: (typeof again)[number]) => {
			if (f.name) return f.name;
			if (f.runtime) return 'the runtime';
			const q = f.url.indexOf('?');
			const p = q === -1 ? f.url : f.url.slice(0, q);
			return p.slice(p.lastIndexOf('/') + 1);
		};
		// the costliest first, so the names that fit are the files that cost most: a revalidation's
		// cost is its round trip (a 304 reports no body), a download's its bytes
		const revalidated = again.filter((f) => f.how === 'revalidated').sort((a, b) => b.ms - a.ms);
		const downloaded = again.filter((f) => f.how === 'downloaded').sort((a, b) => b.bytes - a.bytes);
		const parts: string[] = [];
		if (revalidated.length) {
			// (the requests overlap: the slowest is what the page waited, not their sum)
			parts.push(
				`${revalidated.length === 1 ? 'one was' : `${revalidated.length} were`} revalidated with the server (${list(revalidated.map(name))}): a round trip each${revalidated.length === 1 ? ` (${Math.round(revalidated[0].ms)} ms)` : `, the slowest ${Math.round(revalidated[0].ms)} ms`}, for ${revalidated.length === 1 ? 'a file' : 'files'} that cannot change`
			);
		}
		if (downloaded.length)
			parts.push(`${downloaded.length === 1 ? 'one' : downloaded.length} came down again on this reload (${list(downloaded.map(name))}, ${kb(downloaded.reduce((a, f) => a + f.bytes, 0))}) though the browser had just loaded ${downloaded.length === 1 ? 'it' : 'them'}`);
		findings.push({
			code: 'files-fetched-again',
			severity: 'warn',
			message: `The browser asked the server again for ${again.length === 1 ? 'a file it already had' : `${again.length} files it already had`}: ${parts.join('; ')}. Their names change with their content, so a browser can keep them for good.`,
			fix: "Serve `_app/immutable/` with `cache-control: public, max-age=31536000, immutable` (SvelteKit's adapters do; a proxy, a CDN rule or a custom server in front can override it). The devtools Page tab shows the header the host sends.",
			fps: []
		});
	}

	// ── holes whose answer never came: the page keeps the fallback, and in a build nothing says why ──
	for (const h of page.hole_failures ?? []) {
		const path = (u?: string) => {
			if (!u) return '';
			try {
				return new URL(u, 'http://x').pathname;
			} catch {
				return u;
			}
		};
		const refused = h.reason !== 'error';
		findings.push({
			code: 'hole-failed',
			severity: 'error',
			message: refused
				? `${h.name} never got its answer: the request ${h.reason === 'redirected' ? `was redirected to ${path(h.final_url)}` : `was answered with a whole page (${path(h.final_url)})`}. Something in front of ogygia's handle took it, and the fallback stands.`
				: `${h.name} never got its answer: the request failed ${h.attempts} time${h.attempts === 1 ? '' : 's'} (${h.message ?? 'no reason given'}), and the fallback stands.`,
			fix: refused
				? `A handle that runs before ogygia's (an auth redirect, a locale bounce, a 404 page) answered the islands endpoint (${path(h.endpoint)}). Let that path through untouched there.`
				: `Open ${h.endpoint ?? 'the hole’s endpoint'} (signed for this page) for the server's answer: the hole's server render threw, or the network dropped the request.`,
			fps: h.fp ? [h.fp] : []
		});
	}

	// ── third parties: other origins' bytes, blocking files, main-thread time, runtime-loaded scripts ──
	const origin = page.visit?.origin;
	// main-thread ms per host: the CPU sampler where it saw a host, else the long animation frames'
	// script attribution (which covers the page from its start, before the sampler)
	const host_ms = new Map<string, number>(Object.entries(cpu?.by_host ?? {}));
	for (const s of page.visit?.scripts ?? []) {
		let host = '';
		try {
			host = new URL(s.url).host;
		} catch {
			continue;
		}
		host_ms.set(host, Math.max(host_ms.get(host) ?? 0, 0) + (cpu?.by_host?.[host] ? 0 : s.ms));
	}
	const tp = origin
		? third_party(page.visit?.resources ?? [], origin, cpu?.by_host || page.visit?.scripts ? host_ms : null, page.visit?.named ? new Set(page.visit.named) : undefined, page.visit?.nav?.dom_interactive)
		: null;
	const edited = [
		...page.islands.filter((i) => i.changed || i.recovered || i.healed).map((i) => ({ name: name_of(i.fp, i.entry), done: i.done })),
		...failures.map((f) => ({ name: name_of(f.fp), done: Infinity }))
	];
	for (const f of third_party_findings(tp, edited)) findings.push({ ...f, fps: [] });

	const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
	findings.sort((a, b) => order[a.severity] - order[b.severity]);
	// two copies of an island with the same props share a fingerprint: each named once
	for (const f of findings) if (f.fps.length > 1) f.fps = [...new Set(f.fps)];
	return {
		vitals,
		rows,
		findings,
		blocking,
		bytes: [...bytes_by.values()].sort((a, b) => b.transfer + b.size - (a.transfer + a.size)),
		longtask_ms: round(longtask_ms),
		third_party: tp
	};
}

/**
 * THE LARGEST PAINT, EXPLAINED: the element, the island it is in, and its four parts — the wait for
 * the HTML's first byte, the delay before the browser began fetching its resource (the image found
 * late: in CSS, added by a script, lazy), the resource's download, and the delay after it arrived
 * before it painted (blocking CSS or scripts, or the element shown by a script). A text paint has
 * no resource: first byte, then render. The fix is for the part that cost most.
 */
/** THE FONT THE LARGEST PAINT WAITED FOR: a text paint (no file of its own) that came within 200 ms
 *  of a font file landing after the first paint, whose face hides its text until then (font-display
 *  auto/block). The page's text was there all along, invisible: the font, not the server, set the
 *  LCP. Shared by the Page tab's split and the profiler's LCP gap. */
export function lcp_font(visit: PageInput['visit'] | null | undefined): { family: string; file: string; end: number } | null {
	const p = visit?.paints;
	const faces = visit?.font_faces;
	if (!p || p.lcp_url || typeof p.lcp !== 'number' || typeof p.fcp !== 'number' || !faces?.length) return null;
	let best: { family: string; file: string; end: number } | null = null;
	for (const r of visit.resources ?? []) {
		// (the file's end is the network's clock, the paint the main thread's: a paint may read up to
		// 100 ms before the file it waited for)
		if (r.type !== 'font' || r.end <= p.fcp || r.end - p.lcp > 100 || p.lcp - r.end > 200) continue;
		const face = faces.find((f) => f.urls.includes(r.url));
		if (!face || (face.display !== 'auto' && face.display !== 'block')) continue;
		// (no later than the paint: the parts never run backwards)
		const end = Math.min(r.end, p.lcp);
		if (!best || end > best.end) best = { family: face.family, file: r.url.slice(r.url.lastIndexOf('/') + 1).split('?')[0], end };
	}
	return best;
}

/** WHAT THE LARGEST PAINT'S DOWNLOAD SHARED THE NETWORK WITH: images far below the first screen,
 *  not lazy, whose own download overlapped the largest paint's file (or, a text paint, the wait from
 *  the first byte to the paint). Shared by the Page tab's split and the profiler's LCP gap. */
export function lcp_rivals(visit: PageInput['visit'] | null | undefined): { bytes: number; files: string[] } | null {
	const below = visit?.images_eager_below;
	const p = visit?.paints;
	if (!visit || !below?.length || typeof p?.lcp !== 'number') return null;
	const resources = visit.resources ?? [];
	const res = p.lcp_url ? resources.find((r) => r.url === p.lcp_url) : undefined;
	const from = res ? (res.req_start ?? res.start) : (visit.nav?.res_start ?? 0);
	const to = res ? res.end : p.lcp;
	let bytes = 0;
	const files: string[] = [];
	for (const i of below) {
		const r = resources.find((x) => x.url === i.url);
		if (!r || r.start >= to || r.end <= from) continue;
		bytes += i.bytes;
		const f = i.url.slice(i.url.lastIndexOf('/') + 1).split('?')[0];
		if (!files.includes(f)) files.push(f);
	}
	return bytes ? { bytes, files } : null;
}

/** elements whose largest paint is their own file; any other with a URL painted a CSS background */
const LCP_OWN_FILE: ReadonlySet<string> = new Set(['img', 'image', 'video', 'svg', 'input']);

/**
 * WHY THE BROWSER FOUND THE LARGEST PAINT'S FILE LATE, from what the visit saw: a CSS background
 * (found only once its stylesheet is in and the element laid out), an image its island's code added
 * as it woke (the request began after it hydrated: the server HTML had none), or an `<img>` in the
 * HTML at the low priority an image starts at. The generic advice when none of them is it.
 */
export function late_found(
	p: NonNullable<NonNullable<PageInput['visit']>['paints']> | undefined,
	res: { start: number; req_start?: number } | undefined,
	islands: readonly PageIsland[],
	name_of: (fp: string | undefined) => string
): string {
	const tag = p?.lcp_tag ?? '';
	// (lazy: the browser held it until layout — a late start of its own making, whatever woke when)
	if (p?.lcp_lazy) return 'It carries `loading="lazy"`: the browser held its fetch until layout said it was on screen. Drop it from the first screen\'s images, and give this one `fetchpriority="high"`.';
	if (p?.lcp_url && tag && !LCP_OWN_FILE.has(tag))
		return `It is a CSS background image (on the ${tag}): the browser finds it only once the stylesheet has arrived and the element is laid out. Put it in the server HTML as an \`<img>\` with \`fetchpriority="high"\`, or preload it (\`<link rel="preload" as="image" fetchpriority="high">\`).`;
	const asked = res ? (res.req_start ?? res.start) : undefined;
	const island = p?.lcp_fp ? islands.find((i) => i.fp === p.lcp_fp) : undefined;
	if (island && asked !== undefined && asked >= island.done - 1)
		return `Its request began at ${Math.round(asked)} ms, after ${name_of(p?.lcp_fp)} woke (hydrated at ${Math.round(island.done)} ms): the server HTML did not carry it, the island's code added it. Render the \`<img>\` (the same src) in the island's server markup, so the browser finds it in the HTML.`;
	if (tag === 'img' && p?.lcp_priority !== 'high')
		return 'It is an `<img>` the browser could find in the HTML, but an image starts at low priority, behind the page\'s scripts and stylesheets: give it `fetchpriority="high"` (and never `loading="lazy"` on the first screen).';
	if (tag === 'img')
		return 'It already asks for high priority: something before it held the browser back (a blocking script in the `<head>`, a long chain of stylesheets). Preload it in the `<head>` (`<link rel="preload" as="image" fetchpriority="high">`), ahead of the rest.';
	return 'The browser found it late: put it in the HTML as an `<img>` (not a CSS background or a script-added one), never `loading="lazy"` on the first screen, and preload it with `fetchpriority="high"`.';
}

function explain_lcp(page: PageInput, name_of: (fp: string | undefined) => string): { message: string; fix: string; fps: string[] } | null {
	const p = page.visit?.paints;
	const lcp = p?.lcp ?? page.vitals.lcp;
	const ttfb = page.visit?.nav?.res_start;
	if (typeof lcp !== 'number' || typeof ttfb !== 'number' || !(lcp > 0)) return null;
	const file = (u: string) => {
		const q = u.indexOf('?');
		const s = q === -1 ? u : u.slice(0, q);
		return s.slice(s.lastIndexOf('/') + 1) || u;
	};
	const res = p?.lcp_url ? (page.visit?.resources ?? []).find((r) => r.url === p.lcp_url) : undefined;
	const what = `${p?.lcp_tag ? `the ${p.lcp_tag}` : 'an element'}${p?.lcp_url ? ` (${file(p.lcp_url)})` : ''}${p?.lcp_fp ? ` in ${name_of(p.lcp_fp)}` : ''}`;
	const ms = (n: number) => `${Math.round(Math.max(0, n))} ms`;
	type Part = { key: 'ttfb' | 'delay' | 'load' | 'render' | 'font'; ms: number; text: string };
	let parts: Part[];
	const font = res ? null : lcp_font(page.visit);
	if (font) {
		parts = [
			{ key: 'ttfb', ms: ttfb, text: `${ms(ttfb)} until the HTML's first byte` },
			{ key: 'font', ms: font.end - ttfb, text: `${ms(font.end - ttfb)} waiting for its font '${font.family}' (${font.file}), the text invisible until it came` },
			{ key: 'render', ms: lcp - font.end, text: `${ms(lcp - font.end)} more before it painted` }
		];
	} else if (res) {
		const asked = res.req_start ?? res.start;
		parts = [
			{ key: 'ttfb', ms: ttfb, text: `${ms(ttfb)} until the HTML's first byte` },
			{ key: 'delay', ms: asked - ttfb, text: `${ms(asked - ttfb)} before the browser began fetching it` },
			{ key: 'load', ms: res.end - asked, text: `${ms(res.end - asked)} downloading it` },
			{ key: 'render', ms: lcp - res.end, text: `${ms(lcp - res.end)} more before it painted` }
		];
	} else {
		parts = [
			{ key: 'ttfb', ms: ttfb, text: `${ms(ttfb)} until the HTML's first byte` },
			{ key: 'render', ms: lcp - ttfb, text: `${ms(lcp - ttfb)} more before it painted` }
		];
	}
	const top = parts.reduce((a, b) => (b.ms > a.ms ? b : a));
	const fix =
		top.key === 'ttfb'
			? "The server's first byte is most of it: make the page's own render faster (the profiler's report of this page names the slow load), or cache it."
			: top.key === 'font'
				? "The text was there, hidden by its font: give the @font-face `font-display: swap` (or `optional`) and preload the font file, so the text paints at once."
				: top.key === 'delay'
					? late_found(p, res, page.islands, name_of)
					: top.key === 'load'
						? 'The file itself is slow to download: make it smaller (a modern format, sized to how it is shown, `srcset`), and serve it from close by.'
						: 'It was ready but did not paint: render-blocking stylesheets or scripts held the first paint, or a script (an island waking) shows the element. Render it with the server HTML, and inline or trim what blocks.';
	// (a download or a late start that shared the network with images nobody saw yet)
	const rivals = top.key === 'load' || top.key === 'delay' || top.key === 'font' ? lcp_rivals(page.visit) : null;
	const kb = (n: number) => `${Math.round(n / 1024)} KB`;
	return {
		message: `The largest paint was ${what}: ${parts.map((x) => x.text).join(', ')}.${rivals ? ` Beside it, ${kb(rivals.bytes)} of images far below the first screen downloaded (${rivals.files.join(', ')}).` : ''}`,
		fix: rivals ? `${fix} And give the images below the first screen \`loading="lazy"\`: they took a share of the network the largest paint needed.` : fix,
		fps: p?.lcp_fp ? [p.lcp_fp] : []
	};
}

/**
 * A VITAL'S PARTS, as numbers (the same splits the explanations word): TTFB by its steps, FCP by
 * first byte / HTML / blocking / render, LCP by first byte / delay / download / render, INP by the
 * slowest interaction's wait / handlers / paint. What "since your last profile" (the profiler) and
 * "since your last load" (the Page tab) compare, to say which part of a moved vital moved. Null
 * when the visit cannot tell.
 */
export type PartedVital = 'ttfb' | 'fcp' | 'lcp' | 'inp';
export interface VitalPart {
	key: string;
	label: string;
	ms: number;
}
export interface VitalMove {
	key: 'ttfb' | 'fcp' | 'lcp' | 'cls' | 'inp';
	a: number;
	b: number;
	/** the part of a split vital that moved most (≥ 50 ms, else left out) */
	part?: { label: string; a: number; b: number };
}

/** a vital moved when it changed by at least this much AND a fifth of the old value (CLS: this much) */
const VITAL_FLOOR = { ttfb: 50, fcp: 100, lcp: 100, inp: 40, cls: 0.05 } as const;
/** the part named only when it moved at least this much */
const PART_FLOOR_MS = 50;

/**
 * WHICH VITALS MOVED between two visits of a page, past the noise, and for a split vital the part
 * that moved most. ONE rule for both tools: the profiler's "since your last profile" and the Page
 * tab's "since your last load" read the same moves. `parts(side, key)` gives a side's parts.
 */
export function vitals_moved(
	a: Record<string, number | undefined>,
	b: Record<string, number | undefined>,
	parts: (side: 'a' | 'b', key: PartedVital) => VitalPart[] | null
): VitalMove[] {
	const out: VitalMove[] = [];
	for (const key of ['ttfb', 'fcp', 'lcp', 'cls', 'inp'] as const) {
		const x = a[key];
		const y = b[key];
		if (typeof x !== 'number' || typeof y !== 'number') continue;
		const d = Math.abs(y - x);
		const moved = key === 'cls' ? d >= VITAL_FLOOR.cls : d >= Math.max(VITAL_FLOOR[key], x * 0.2);
		if (!moved) continue;
		const m: VitalMove = { key, a: x, b: y };
		if (key !== 'cls') {
			const pa = parts('a', key);
			const pb = parts('b', key);
			if (pa && pb) {
				let best: VitalMove['part'];
				for (const q of pb) {
					const was = pa.find((p) => p.key === q.key);
					if (!was) continue;
					if (!best || Math.abs(q.ms - was.ms) > Math.abs(best.b - best.a)) best = { label: q.label, a: Math.round(was.ms), b: Math.round(q.ms) };
				}
				if (best && Math.abs(best.b - best.a) >= PART_FLOOR_MS) m.part = best;
			}
		}
		out.push(m);
	}
	return out;
}
export function vital_parts(page: PageInput, key: PartedVital): VitalPart[] | null {
	if (key === 'inp') {
		// (the slowest interaction's own three phases, as its explanation words them)
		const i = page.visit?.interaction;
		if (!i || !(i.delay + i.processing + i.presentation > 0)) return null;
		return [
			{ key: 'delay', label: 'the wait before its handlers', ms: i.delay },
			{ key: 'handler', label: 'its handlers', ms: i.processing },
			{ key: 'paint', label: 'painting the next frame', ms: i.presentation }
		];
	}
	const nav = page.visit?.nav as { res_start?: number; res_end?: number; phases?: NavPhases } | undefined;
	if (key === 'ttfb') {
		const p = nav?.phases;
		if (!p) return null;
		return [
			{ key: 'redirect', label: 'redirects', ms: p.redirect ?? 0 },
			{ key: 'worker', label: 'the service worker', ms: p.worker ?? 0 },
			{ key: 'dns', label: 'the address lookup', ms: p.dns ?? 0 },
			{ key: 'connect', label: 'connecting', ms: (p.connect ?? 0) + (p.tls ?? 0) },
			{ key: 'wait', label: "the server's answer", ms: p.wait ?? 0 }
		];
	}
	const first = nav?.res_start;
	if (typeof first !== 'number') return null;
	if (key === 'fcp') {
		const fcp = page.visit?.paints?.fcp ?? page.vitals.fcp;
		if (typeof fcp !== 'number') return null;
		const html_end = Math.max(first, nav?.res_end ?? first);
		const blocked_until = (page.visit?.resources ?? []).filter((r) => r.blocking && r.start < fcp).reduce((m, r) => Math.max(m, r.end), html_end);
		return [
			{ key: 'ttfb', label: 'the first byte', ms: first },
			{ key: 'html', label: 'the HTML download', ms: html_end - first },
			{ key: 'blocking', label: 'the files that block the paint', ms: blocked_until - html_end },
			{ key: 'render', label: 'the rest before the paint', ms: fcp - blocked_until }
		];
	}
	const p = page.visit?.paints;
	const lcp = p?.lcp ?? page.vitals.lcp;
	if (typeof lcp !== 'number') return null;
	const res = p?.lcp_url ? (page.visit?.resources ?? []).find((r) => r.url === p.lcp_url) : undefined;
	const font = res ? null : lcp_font(page.visit);
	if (font)
		return [
			{ key: 'ttfb', label: 'the first byte', ms: first },
			{ key: 'font', label: `its font '${font.family}'`, ms: font.end - first },
			{ key: 'render', label: 'the render', ms: lcp - font.end }
		];
	if (!res) return [
		{ key: 'ttfb', label: 'the first byte', ms: first },
		{ key: 'render', label: 'the render', ms: lcp - first }
	];
	const asked = res.req_start ?? res.start;
	return [
		{ key: 'ttfb', label: 'the first byte', ms: first },
		{ key: 'delay', label: 'finding the image', ms: asked - first },
		{ key: 'load', label: 'its download', ms: res.end - asked },
		{ key: 'render', label: 'painting it', ms: lcp - res.end }
	];
}

/** the document stayed open at least this long after its first byte (the browser side), or its tail
 *  came this long after the rest (the server side) */
const HELD_OPEN_MS = 250;

/**
 * THE DOCUMENT HELD OPEN: the page painted early, but its HTML kept coming — and islands wake only
 * once the whole document is in (DOMContentLoaded, the wake gate), so every island waited for its
 * end, even one that reads nothing late. Usually a load's streamed promise: the response stays open
 * until the last one settles. From the browser (the navigation's first and last byte, the paint,
 * the islands' hydrate steps after the end) and, when known, what held it (`held_open`: each streamed
 * promise by its `page.data` key and when it settled). With no visit, the profiled render alone
 * says it (its chunks: the early part, then the tail after the longest pause).
 */
export function explain_held_open(page: PageInput, rows: readonly IslandRow[], name_of: (fp: string) => string): PageFinding | null {
	const ms = (n: number) => `${Math.round(n)} ms`;
	const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
	const held = page.held_open;
	// the streamed promises that settled last (within a few ms of the last one): what held it
	const last_at = held?.keys.length ? Math.max(...held.keys.map((k) => k.at)) : undefined;
	const holders = held && last_at !== undefined ? held.keys.filter((k) => k.at >= last_at - 20) : [];
	const holder_text = holders.length
		? holders.map((k) => (k.key ? `\`page.data.${k.key}\`` : 'a streamed promise')).filter((x, i, a) => a.indexOf(x) === i).join(', ')
		: '';
	const fix_streamed =
		'A promise the load returns without awaiting streams, and the document stays open until it settles, so every island waits for it. If the islands need the value anyway, await it in the load: the page ships with it, and nothing waits after. If only one part of the page needs it, make that part a server island (`render: \'deferred\'`): it loads after the page, and the page\'s islands wake without it.';
	const nav = page.visit?.nav;
	const fcp = page.visit?.paints?.fcp ?? page.vitals.fcp;
	if (nav && typeof nav.res_start === 'number' && typeof nav.res_end === 'number') {
		const open = nav.res_end - nav.res_start;
		if (open < HELD_OPEN_MS || typeof fcp !== 'number' || fcp > nav.res_end - 150) return null;
		const end = nav.res_end;
		// the islands whose hydrate step came only after the document's end
		const waited = rows.filter((r) => r.done - r.hydrate_ms >= end - 5);
		if (!waited.length) return null;
		const first = Math.min(...waited.map((r) => r.done - r.hydrate_ms));
		const names = waited.slice(0, 4).map((r) => name_of(r.fp) || r.name);
		const more = waited.length > names.length ? ` and ${waited.length - names.length} more` : '';
		const why = holder_text
			? held!.side === 'server'
				? `; on the server the last ${kb(held!.late_bytes ?? 0)} left ${ms((held!.late_ms ?? 0) - (held!.early_ms ?? 0))} after the rest, held by ${holder_text}`
				: `; it was held by ${holder_text}, settled at ${ms(last_at!)}`
			: '';
		const big = !holder_text && (nav.size ?? 0) >= 300_000;
		return {
			code: 'html-held-open',
			severity: end - fcp >= 300 ? 'warn' : 'info',
			message: `The page painted at ${ms(fcp)}, but its HTML kept coming until ${ms(end)} (${ms(open)} after its first byte)${why}. Islands wake only once the whole document is in (DOMContentLoaded${nav.dcl ? ` at ${ms(nav.dcl)}` : ''}), so ${names.join(', ')}${more} waited: the first hydrated at ${ms(first)}, ${ms(first - fcp)} after the paint.`,
			fix: holder_text
				? fix_streamed
				: big
					? `The HTML itself is large (${kb(nav.size!)}): its download is the wait. Ship less markup: page long lists, move what is below the fold into a server island (\`render: 'deferred'\`), and keep big data out of the page seed.`
					: `Something kept the response open after its first part: usually a promise a load returns without awaiting (it streams, and the document ends only when it settles), or a proxy that buffers. The profiler's report of this page names what the late bytes were. ${fix_streamed}`,
			fps: waited.map((r) => r.fp)
		};
	}
	// no visit: the profiled render alone (its tail left the server long after the rest)
	if (!held || held.side !== 'server' || !holder_text || !held.islands) return null;
	const pause = (held.late_ms ?? 0) - (held.early_ms ?? 0);
	if (pause < HELD_OPEN_MS) return null;
	return {
		code: 'html-held-open',
		severity: 'warn',
		message: `The document streamed: its first ${kb(held.early_bytes ?? 0)} left the server ${ms(held.early_ms ?? 0)} into the render, but it stayed open until ${ms(held.late_ms ?? 0)}, held by ${holder_text}. In the browser, islands wake only once the whole document is in (DOMContentLoaded), so the page's ${held.islands} island${held.islands === 1 ? '' : 's'} wait${held.islands === 1 ? 's' : ''} ${ms(pause)} longer for it.`,
		fix: fix_streamed,
		fps: []
	};
}

/**
 * THE FIRST PAINT, EXPLAINED: its four parts — the wait for the HTML's first byte, the HTML's own
 * download, the files that blocked the paint after it (stylesheets, classic scripts in the head:
 * the slowest named), and the rest before the paint (the main thread busy: long tasks before it).
 * The fix is the costliest part's.
 */
function explain_fcp(page: PageInput): { message: string; fix: string; fps: string[] } | null {
	const nav = page.visit?.nav as { res_start?: number; res_end?: number } | undefined;
	const fcp = page.visit?.paints?.fcp ?? page.vitals.fcp;
	if (typeof fcp !== 'number' || typeof nav?.res_start !== 'number') return null;
	const first = nav.res_start;
	const html_end = Math.max(first, nav.res_end ?? first);
	const blockers = (page.visit?.resources ?? []).filter((r) => r.blocking && r.start < fcp);
	const blocked_until = blockers.reduce((m, r) => Math.max(m, r.end), html_end);
	const slowest = blockers.reduce<(typeof blockers)[number] | undefined>((a, r) => (!a || r.end - r.start > a.end - a.start ? r : a), undefined);
	const busy = page.longtasks.filter((t) => t.t < fcp && t.t + t.ms > blocked_until).reduce((a, t) => a + Math.min(t.t + t.ms, fcp) - Math.max(t.t, blocked_until), 0);
	const ms = (n: number) => `${Math.round(Math.max(0, n))} ms`;
	const file = (u: string) => {
		const q = u.indexOf('?');
		const s = q === -1 ? u : u.slice(0, q);
		return s.slice(s.lastIndexOf('/') + 1) || u;
	};
	const parts = [
		{ key: 'ttfb', ms: first, text: `${ms(first)} until the HTML's first byte` },
		{ key: 'html', ms: html_end - first, text: `${ms(html_end - first)} downloading the HTML` },
		{ key: 'blocking', ms: blocked_until - html_end, text: `${ms(blocked_until - html_end)} waiting for ${blockers.length === 1 ? 'a file that blocks' : `${blockers.length} files that block`} the paint${slowest ? ` (the slowest ${file(slowest.url)}, ${ms(slowest.end - slowest.start)})` : ''}` },
		{ key: 'render', ms: fcp - blocked_until, text: `${ms(fcp - blocked_until)} more before it painted${busy >= 50 ? ` (${ms(busy)} of it long tasks)` : ''}` }
	].filter((p) => p.ms >= 1 || p.key === 'ttfb');
	const top = parts.reduce((a, b) => (b.ms > a.ms ? b : a));
	const fix =
		top.key === 'ttfb'
			? "The server's first byte is most of it: see the first-byte finding (and the profiler's report of this page) for where the server's time went."
			: top.key === 'html'
				? 'The HTML itself is slow to arrive: send less of it (render below-the-fold parts later, trim inline data), and make sure it is compressed.'
				: top.key === 'blocking'
					? `The paint waits for ${slowest ? file(slowest.url) : 'blocking files'}: inline the few rules the first screen needs and load the rest without blocking, and give scripts in the head \`defer\` or \`type="module"\`.`
					: 'Everything had arrived, but the main thread was busy: a script ran before the first paint. Move it after (defer it, or run it on idle).';
	return { message: `The first paint came after ${parts.map((p) => p.text).join(', ')}.`, fix, fps: [] };
}

/**
 * THE WAIT FOR THE FIRST BYTE, EXPLAINED: the steps the browser timed before it (a redirect, a
 * service worker starting, the DNS lookup, the connection and its TLS, the request until the
 * server answered), and — when the document carries it — what the server's own Server-Timing says
 * its wait went to. The fix is the costliest step's.
 */
/** What the profiler's last run of the page says the server did (or how to find out). */
function server_says(brief: ServerProfileBrief | undefined): string {
	if (!brief) return ' Profile this page (the Profiler tab) to see where the server’s time went.';
	const ago = brief.ago_min < 1 ? 'just now' : `${Math.round(brief.ago_min)} min ago`;
	// (a prerendered page: no render to profile — its first byte is a file being served)
	if (brief.prerendered)
		return ` The profiler's last run of this page (${ago}) found it prerendered${brief.prerendered === 'file' ? ': the server answered with the file the build wrote, no render ran' : ' (its route exports prerender)'} — its first byte is a file being served, so a slow one is the host or the network, not a render to profile.`;
	return ` The profiler's last run of this page (${ago}): the server render took ${Math.round(brief.render_ms)} ms${brief.calls ? `, ${brief.calls} outbound call${brief.calls === 1 ? '' : 's'} (${Math.round(brief.calls_ms)} ms)` : ', no outbound calls'}${brief.top ? `; it says: ${brief.top}` : ''}.`;
}

function explain_ttfb(page: PageInput): { message: string; fix: string; fps: string[]; note?: boolean } | null {
	const p = page.visit?.nav?.phases;
	if (!p) return null;
	const ms = (n: number) => `${Math.round(n)} ms`;
	const steps = [
		{ key: 'redirect', ms: p.redirect ?? 0, text: `${ms(p.redirect ?? 0)} in redirects` },
		{ key: 'worker', ms: p.worker ?? 0, text: `${ms(p.worker ?? 0)} starting a service worker` },
		{ key: 'dns', ms: p.dns ?? 0, text: `${ms(p.dns ?? 0)} looking up the address` },
		{ key: 'connect', ms: (p.connect ?? 0) + (p.tls ?? 0), text: `${ms((p.connect ?? 0) + (p.tls ?? 0))} connecting${p.tls ? ` (${ms(p.tls)} of it TLS)` : ''}` },
		{ key: 'wait', ms: p.wait ?? 0, text: `${ms(p.wait ?? 0)} waiting for the server's answer` }
	].filter((s) => s.ms >= 1);
	if (!steps.length) return null;
	const top = steps.reduce((a, b) => (b.ms > a.ms ? b : a));
	const st = (page.visit?.nav?.server_timing ?? []).filter((s) => s.ms >= 1).sort((a, b) => b.ms - a.ms).slice(0, 4);
	const said = st.length ? ` The server's Server-Timing says: ${list(st.map((s) => `${s.desc || s.name} ${ms(s.ms)}`))}.` : '';
	// THE WAIT, SPLIT BY THE RENDER: SvelteKit's render time rides the document's Server-Timing (the
	// profiler's `ssr` entry, for its own user); what the wait holds beyond it came before the render
	// or around it — on the dev server, mostly the page compiling on its first request
	const ssr = (page.visit?.nav?.server_timing ?? []).find((s) => s.name === 'ssr');
	const beyond = ssr && p.wait ? Math.max(0, p.wait - ssr.ms) : 0;
	const compiling = !!page.dev && top.key === 'wait' && beyond >= Math.max(300, (p.wait ?? 0) / 2);
	const split =
		top.key === 'wait' && ssr && beyond >= 200
			? ` Of the ${ms(p.wait ?? 0)} wait, the render was ${ms(ssr.ms)}; the other ${ms(beyond)} came before it${compiling ? ' — on the dev server, the page compiling on its first request' : ' (a hook, a proxy, a cold start)'}.`
			: '';
	const fix = compiling
		? 'Reload the page: on the dev server a page is compiled on its first request, and that is most of this first byte. A build (or a second visit) shows the real one.'
		: top.key === 'redirect'
			? 'The redirects are the cost: link to the final address (the trailing slash, https, the locale) so the browser asks once.'
			: top.key === 'worker'
				? "The service worker's start is the cost: keep it small, or turn on navigation preload so the page's request leaves while it starts."
				: top.key === 'dns' || top.key === 'connect'
					? 'Reaching the server is the cost: serve the page from closer to the visitor (a CDN at the edge), and keep the connection modern (HTTP/2 or 3, TLS 1.3).'
					: page.server_profiles && page.server_profile?.prerendered
						? 'The page is a prerendered file, and still slow to arrive: serve it from close to the visitor (a CDN keeps the built files at the edge), and check what stands in front of the files — a function or a middleware answering them first, a cold start, a slow origin.'
						: "The server's answer is the cost: profile the page (its report names the slow load and the lines in it), cache the HTML where it is the same for everyone, or stream it so the first byte leaves before the slow part.";
	// (devtools: the server's side from the Profiler tab's last run of this page, when the wait is it)
	const profiled = page.server_profiles && top.key === 'wait' && !compiling ? server_says(page.server_profile) : '';
	return { message: `Before the page's first byte: ${steps.map((s) => s.text).join(', ')}.${said}${split}${profiled}`, fix, fps: [], ...(compiling ? { note: true } : {}) };
}

/**
 * THE WORST LAYOUT SHIFTS, EXPLAINED: CLS scores the worst burst of shifts (a session: shifts under a
 * second apart, five seconds at most). This names what moved in it (the island, else the element),
 * and what made it move — by what happened just before its biggest shift: a hole's answer swapped
 * in, an image arrived with no size set, a web font swapped in, an island hydrated. The fix is the
 * cause's; an unknown one says what to look at.
 */
function explain_cls(page: PageInput, rows: readonly IslandRow[], name_of: (fp: string | undefined) => string): { message: string; fix: string; fps: string[]; note?: true } | null {
	const shifts = [...page.shifts].sort((a, b) => a.t - b.t);
	if (!shifts.length) return null;
	// the sessions: a new one after a second's gap, or past five seconds long
	let best: typeof shifts = [];
	let best_sum = 0;
	let cur: typeof shifts = [];
	let cur_sum = 0;
	for (const s of shifts) {
		if (cur.length && (s.t - cur[cur.length - 1].t > 1000 || s.t - cur[0].t > 5000)) {
			cur = [];
			cur_sum = 0;
		}
		cur.push(s);
		cur_sum += s.value;
		if (cur_sum > best_sum) {
			best = cur.slice();
			best_sum = cur_sum;
		}
	}
	if (!best.length) return null;
	// what moved: by island, else by the element, the biggest first
	const moved = new Map<string, number>();
	for (const s of best) {
		const who = s.fp ? name_of(s.fp) : s.tag || 'an element';
		moved.set(who, (moved.get(who) ?? 0) + s.value);
	}
	const top = [...moved].sort((a, b) => b[1] - a[1]).slice(0, 3);
	const round3 = (n: number) => Math.round(n * 1000) / 1000;
	// what made it move: the event just before the burst's biggest shift (within a quarter second)
	const big = best.reduce((a, b) => (b.value > a.value ? b : a));
	const WINDOW = 250;
	const file = (u: string) => {
		const q = u.indexOf('?');
		const s = q === -1 ? u : u.slice(0, q);
		return s.slice(s.lastIndexOf('/') + 1) || u;
	};
	type Cause = { at: number; kind: 'hole' | 'img' | 'font' | 'island' | 'devcss'; name: string };
	const causes: Cause[] = [];
	for (const h of page.hole_waits ?? []) if (h.shown_at !== undefined) causes.push({ at: h.shown_at + h.wait_ms, kind: 'hole', name: h.name });
	for (const r of page.visit?.resources ?? []) {
		if (r.type === 'img') causes.push({ at: r.end, kind: 'img', name: file(r.url) });
		else if (r.type === 'font') causes.push({ at: r.end, kind: 'font', name: file(r.url) });
		// (the dev server serves a component's CSS as a module — `X.svelte?svelte&type=style` — and
		// adds it with JavaScript after the first paint; a build links it in the head)
		else if (page.dev && r.url.includes('type=style')) causes.push({ at: r.end, kind: 'devcss', name: file(r.url) });
	}
	for (const r of rows) causes.push({ at: r.done, kind: 'island', name: r.name });
	let cause: Cause | undefined;
	for (const c of causes) if (c.at <= big.t + 5 && big.t - c.at <= WINDOW && (!cause || c.at > cause.at)) cause = c;
	const because =
		!cause
			? ''
			: cause.kind === 'hole'
				? ` It came right after ${cause.name.startsWith('the hole') ? cause.name : `the hole ${cause.name}`}'s answer swapped in: the answer is not the size of its fallback.`
				: cause.kind === 'img'
					? ` It came right after the image ${cause.name} arrived: it had no size set, so the page made room when it loaded.`
					: cause.kind === 'font'
						? ` It came right after the web font ${cause.name} arrived: text re-laid out in it.`
						: cause.kind === 'devcss'
							? ` It came right after ${cause.name}'s styles arrived: the dev server adds a component's CSS with JavaScript after the first paint, so the page re-laid out in them. A build links that CSS in the head — this shift is the dev server's, not your page's.`
							: ` It came right after ${cause.name} hydrated: the island's size changed as it woke.`;
	const fix = !cause
		? 'Nothing the page timed explains it: look for content added above what is on screen (a banner, an ad, a late script), or an animation that moves layout instead of `transform`.'
		: cause.kind === 'hole'
			? 'Give the hole a fallback the size of its answer (a placeholder with a fixed or `min-height`), so the swap changes nothing around it.'
			: cause.kind === 'img'
				? 'Set the image\'s `width` and `height` (or an `aspect-ratio`) so its space is kept before it loads.'
				: cause.kind === 'font'
					? 'Match the fallback font\'s metrics (`size-adjust`, `ascent-override`), or preload the font, so the swap does not move text.'
					: cause.kind === 'devcss'
						? 'Nothing to fix for this shift: check the page on a build (preview or deploy), where the CSS is in the head before the first paint.'
						: 'Render the island at its final size on the server (the same content, or a placeholder of that height), so waking it changes nothing on screen.';
	return {
		message: `The worst burst of shifts added ${round3(best_sum)}, ${best.length === 1 ? 'in one shift' : `over ${best.length} shifts in ${Math.round(best[best.length - 1].t - best[0].t)} ms`}: what moved was ${list(top.map(([n, v]) => `${n} (${round3(v)})`))}.${because}`,
		fix,
		fps: [...new Set(best.map((s) => s.fp).filter((f): f is string => !!f))],
		// (the dev server's own CSS injection: a note, like a page compiling on its first request)
		...(cause?.kind === 'devcss' ? { note: true as const } : {})
	};
}

/** One long-frame script, told: `BusyTimer.svelte's planted_busy_timer (a timer, 400 ms)`. */
function describe_script(s: NonNullable<PageInteraction['scripts']>[number]): string {
	let who = s.island ?? '';
	if (!who) {
		const q = s.url.indexOf('?');
		const p = q === -1 ? s.url : s.url.slice(0, q);
		who = p.slice(p.lastIndexOf('/') + 1) || 'a script';
	}
	const kind = script_kind(s.invoker);
	return `${who}${s.fn ? `'s ${s.fn}` : ''} (${kind ? `${kind}, ` : ''}${Math.round(s.ms)} ms)`;
}

/** What ran a long-frame script, from its invoker: a timer, an animation frame, a promise, … */
function script_kind(inv: string): string {
	return inv.startsWith('TimerHandler')
		? 'a timer'
		: inv.startsWith('FrameRequestCallback')
			? 'an animation frame'
			: inv.includes('requestIdleCallback')
				? 'an idle callback'
				: inv.includes('.then') || inv.startsWith('Promise')
					? 'a promise'
					: inv.includes('.on')
						? 'an event handler'
						: '';
}

/** THE SLOWEST INTERACTION, explained: where it landed, which phase cost the time, and what held
 *  it — an island hydrating, a script in a long frame, the handler's own code, or the paint. */
function explain_interaction(
	i: PageInteraction | undefined,
	rows: readonly IslandRow[],
	name_of: (fp: string | undefined) => string,
	origin: string | undefined,
	cpu?: InteractionCpuInput
): { message: string; fix: string; fps: string[] } | null {
	if (!i || !(i.delay + i.processing + i.presentation > 0)) return null;
	const what = i.name === 'click' || i.name.startsWith('pointer') || i.name.startsWith('mouse') ? 'a click' : i.name.startsWith('key') ? 'a key press' : `a ${i.name}`;
	const where = i.fp ? `in ${name_of(i.fp)}` : 'outside any island';
	const on = i.target ? ` on ${i.target}` : '';
	const ms = (n: number) => `${Math.round(n)} ms`;
	const phases = [
		{ key: 'delay' as const, ms: i.delay, text: `${ms(i.delay)} before its handlers could run` },
		{ key: 'handler' as const, ms: i.processing, text: `${ms(i.processing)} in its handlers` },
		{ key: 'paint' as const, ms: i.presentation, text: `${ms(i.presentation)} to paint the next frame` }
	];
	const top = phases.reduce((a, b) => (b.ms > a.ms ? b : a));
	const scripts = i.scripts ?? [];
	const of_phase = (p: 'delay' | 'handler' | 'paint') => scripts.filter((s) => s.phase === p);
	// what the input waited behind: islands hydrating then (their hydrate step overlapped the wait),
	// else the scripts of the long frames that ran in it
	const wait_end = i.t + i.delay;
	const hydrating = rows.filter((r) => r.fp !== i.fp && Math.min(r.done, wait_end) - Math.max(r.done - r.hydrate_ms, i.t) > 1);
	const behind = hydrating.length
		? `${list(hydrating.map((r) => r.name))} ${hydrating.length === 1 ? 'was' : 'were'} hydrating`
		: of_phase('delay').length
			? `the main thread was running ${list(of_phase('delay').slice(0, 3).map(describe_script))}`
			: '';
	const handler = of_phase('handler')[0];
	// Svelte delegates events: the frame names its one dispatcher (or, built, a minified function in
	// a chunk), never the island's handler it called. A page-origin event handler for a click inside
	// an island is that island's own; another origin's listener keeps its name (a third party's)
	const own_origin = (url: string) => {
		if (!origin) return true;
		try {
			return new URL(url, origin).origin === origin;
		} catch {
			return true;
		}
	};
	// SAMPLED: when a trace of this interaction was taken, the function that ran — by its real name
	// and line — over what the frames could tell (the app's own code first: a Svelte internal or the
	// browser under it is not what a reader changes)
	const sampled = cpu && Math.abs(cpu.t - i.t) < 2 ? cpu : undefined;
	// (only a frame that reads as source: a built chunk's minified `Ce` in `og-region.x.js:1` tells a
	// reader less than the frames do — the profiler source-maps a build's, the page cannot)
	const readable = (f: CpuFn) => f.file.endsWith('.svelte') || f.file.startsWith('src/') || f.file.includes('/src/');
	const pick = (s: { ms: number; top: CpuFn[] } | null | undefined) => {
		const f = s?.top.find((x) => x.kind === 'app') ?? s?.top[0];
		return f && readable(f) ? f : undefined;
	};
	const handler_fn = pick(sampled?.handler);
	const wait_fn = pick(sampled?.wait);
	// (a line of the served code is not the source's: without a map, the function and its file only)
	const fn_label = (f: CpuFn) => (sampled?.mapped ? label_of(f) : label_of({ ...f, line: null }));
	const own_handler = !!handler && !!i.fp && handler.invoker.includes('.on') && own_origin(handler.url);
	const handler_text = handler_fn
		? `${own_handler || (!handler && i.fp) ? `${name_of(i.fp)}'s ${fn_label(handler_fn)}` : fn_label(handler_fn)}, ${Math.round(handler_fn.self_ms)} ms sampled`
		: !handler
			? ''
			: own_handler
				? `${name_of(i.fp)}'s own ${i.name} handler`
				: describe_script(handler);
	// the wait: an island hydrating says it all; else the sampled function, with what the frames
	// add (the timer or promise that ran it)
	const wait_text = hydrating.length
		? behind
		: wait_fn
			? `the main thread was running ${fn_label(wait_fn)}, ${Math.round(wait_fn.self_ms)} ms sampled${of_phase('delay')[0] && script_kind(of_phase('delay')[0].invoker) ? `, run by ${script_kind(of_phase('delay')[0].invoker)}` : ''}`
			: behind;
	// THE HANDLERS' FORCED LAYOUT: of their time, the browser laying the page out mid-run because the
	// code read a size after a change (a third of it or more, 16 ms or more: what to say first)
	const forced_ms = of_phase('handler').reduce((s, x) => s + (x.forced ?? 0), 0);
	const forced = forced_ms >= 16 && forced_ms >= i.processing * 0.3 ? Math.min(forced_ms, i.processing) : 0;
	const forced_text = forced ? `; ${ms(forced)} of it the browser laying the page out again because the code read sizes after changing it` : '';
	const parts = phases.map((p) => {
		if (p.key === 'delay' && wait_text && p.ms >= 16) return `${p.text} (${wait_text})`;
		if (p.key === 'handler' && handler_text && p.ms >= 16) return `${p.text} (mostly ${handler_text}${forced_text})`;
		if (p.key === 'handler' && forced) return `${p.text} (${forced_text.slice(2)})`;
		return p.text;
	});
	const message = `The slowest was ${what}${on} ${where}: ${parts[0]}, ${parts[1]}, ${parts[2]}.`;
	const fix =
		top.key === 'delay'
			? hydrating.length
				? 'The input waited for islands to hydrate: wake the ones not needed at once later (wake="visible" or "idle"), or make their hydration lighter, so a click is never queued behind it.'
				: 'The input waited for other work on the main thread: split that long task (yield between steps with `await new Promise(r => setTimeout(r))`), or move it off the main thread, or run it when the visitor is not interacting.'
			: top.key === 'handler'
				? forced
					? 'Much of the handler is forced layout: it reads a size or position (offsetHeight, getBoundingClientRect, getComputedStyle) after changing the page, and the browser lays the page out again for each read. Read every size first, then make the changes (or batch them in one requestAnimationFrame); never read between writes in a loop.'
					: 'The handler itself is the cost: update the screen first and do the heavy part after the next frame (`requestAnimationFrame` then `setTimeout`), do less per event, or move the work to a worker.'
				: 'Painting the result is the cost: the handler changed a lot of the page. Change less per update (a shorter list, `content-visibility: auto` for off-screen parts), and avoid reading layout right after writing it.';
	return { message, fix, fps: i.fp ? [i.fp] : [] };
}

/** Names with their copies counted: `BatchHole ×4`, `Menu and Cart ×2`. */
/**
 * On the dev server: how much of an island's code load was the server COMPILING files on this
 * request — the time (overlaps counted once) the server took to answer each file fetched in its load
 * window, when that took 80 ms or more (a transform: a warm dev server answers in a few). 0 off the
 * dev server, or when the visit does not list the files.
 */
export function dev_compile_ms(page: Pick<PageInput, 'dev' | 'visit'>, r: Pick<IslandRow, 't0' | 'load_ms'>): number {
	if (!page.dev) return 0;
	const from = r.t0 - 5;
	const to = r.t0 + r.load_ms + 5;
	const spans: [number, number][] = [];
	for (const f of page.visit?.resources ?? []) {
		if (f.req_start === undefined || f.res_start === undefined || f.req_start < from || f.res_start > to) continue;
		if (f.res_start - f.req_start >= 80) spans.push([f.req_start, f.res_start]);
	}
	spans.sort((a, b) => a[0] - b[0]);
	let total = 0;
	let end = -Infinity;
	for (const [a, b] of spans) {
		if (b <= end) continue;
		total += b - Math.max(a, end);
		end = b;
	}
	return total;
}

function counted(names: string[]): string {
	const n = new Map<string, number>();
	for (const s of names) n.set(s, (n.get(s) ?? 0) + 1);
	return list([...n].map(([s, c]) => (c > 1 ? `${s} ×${c}` : s)));
}

/** A URL's path (and query), for naming where something answered from. */
function path_of(url: string): string {
	try {
		const u = new URL(url, 'http://x');
		return u.pathname + u.search;
	} catch {
		return url;
	}
}

function list(names: string[]): string {
	const uniq = [...new Set(names)];
	if (uniq.length <= 1) return uniq[0] ?? '';
	if (uniq.length <= 4) return uniq.slice(0, -1).join(', ') + ' and ' + uniq[uniq.length - 1];
	return uniq.slice(0, 3).join(', ') + ` and ${uniq.length - 3} more`;
}
function clip(s: string): string {
	const one = s.split('\n').join(' ');
	return one.length > 70 ? one.slice(0, 69) + '…' : one;
}
function short(url: string): string {
	const q = url.indexOf('?');
	const path = q === -1 ? url : url.slice(0, q);
	return path.slice(path.lastIndexOf('/') + 1) || path;
}
