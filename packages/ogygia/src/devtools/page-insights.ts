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
import { without_comments } from '../runtime/beacon.js';
import { fn_label, type CpuSummary } from './cpu.js';
import { third_party, third_party_findings, type ThirdParty } from './third-party.js';

export interface PageIsland {
	fp: string;
	entry?: string;
	t0: number;
	loaded: number;
	turn?: number;
	done: number;
	recovered?: boolean;
	changed?: boolean;
	/** another script edited it before it woke; the runtime put the server markup back */
	healed?: boolean;
	ssr_bytes?: number;
}

export interface PageInput {
	vitals: { ttfb?: number; fcp?: number; lcp?: number; cls?: number; inp?: number };
	visit: {
		nav?: { dcl?: number; load?: number; res_start?: number; dom_interactive?: number };
		/** main-thread ms per script URL, from long animation frames (from the page's start) */
		scripts?: { url: string; ms: number; count: number }[];
		/** Svelte's hydration warnings (dev): the server and the browser disagreed, Svelte kept the server's */
		warnings?: { code: string; message: string; file?: string; fp?: string }[];
		paints?: { fcp?: number; lcp?: number; lcp_fp?: string; lcp_tag?: string; lcp_url?: string };
		resources?: { url: string; type: string; start: number; end: number; transfer?: number; size?: number; blocking?: boolean }[];
		/** every file by type, when the visit lists only some of them one by one */
		resource_totals?: { type: string; count: number; transfer: number; size: number }[];
		viewport?: [number, number];
		/** the page's origin (third parties are every other one) */
		origin?: string;
		/** URLs the document itself names (its scripts, preloads, their imports): a script not among
		 *  them was loaded at runtime by another script */
		named?: string[];
	} | null;
	islands: PageIsland[];
	firsts: { fp: string; t: number; type: string }[];
	shifts: { t: number; value: number; fp?: string }[];
	longtasks: { t: number; ms: number }[];
	snapshots?: { fp: string; ssr: string; hydrated: string; final?: string }[];
	/** awake islands showing a children slot with nothing in it (read off the DOM; devtools only) */
	empty_slots?: string[];
	/** holes whose answer never came (the bus; devtools only) */
	hole_failures?: HoleFailure[];
	/** each island's app code in dev (the dev server's module graph; devtools only) */
	island_code?: IslandCode[];
}

export interface IslandCode {
	fp?: string;
	name: string;
	/** the island's app code, served size in dev */
	bytes: number;
	/** its heaviest modules */
	top: { file: string; bytes: number }[];
	/** re-export barrels still imported whole, with the app modules each drags in */
	barrels: { file: string; fanout: number }[];
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
}

export interface Failure {
	fp?: string;
	message: string;
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
export interface PageFinding {
	code: string;
	severity: Severity;
	message: string;
	fix?: string;
	/** the islands it is about (to light up on the page) */
	fps: string[];
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

/** a shift counts against an island when it lands within this long after the island hydrated */
const SHIFT_WINDOW_MS = 600;
/** a hydrate step this long is a long task of its own */
const LONG_HYDRATE_MS = 50;
/** waiting this long for a turn after the module arrived */
const LONG_QUEUE_MS = 150;
/** a wait with nothing ahead this long is the scheduler's own (its viewport snapshot waits at most
 *  48 ms by design, and its first report lands within a frame or two) */
const HELD_IDLE_MS = 40;
/** a module load this slow */
const SLOW_LOAD_MS = 800;
/** an above-the-fold island still asleep this long after the largest paint */
const LATE_MS = 1000;
/** a wake-at-load island still asleep this long after the load event */
const NEVER_MS = 3000;
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

export function analyze_page(page: PageInput, regions: RegionFact[], failures: Failure[] = [], now = Infinity, cpu: CpuSummary | null = null): PageReport {
	/** " — mostly in `fn (file:line)`" from the CPU trace, for a finding about this island (or '') */
	const why_cpu = (fp: string | null): string => {
		const f = fp ? cpu?.islands[fp]?.top[0] : cpu?.outside.top[0];
		return f && f.self_ms >= 5 ? `; mostly ${fn_label(f)}` : '';
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
	const rows: IslandRow[] = [];
	for (const i of latest.values()) {
		const fact = by_fp.get(i.fp);
		const lo = i.turn ?? i.loaded;
		let shift = 0;
		for (const s of page.shifts) if (s.fp === i.fp && s.t >= i.done - 16 && s.t <= i.done + SHIFT_WINDOW_MS) shift += s.value;
		let lt = 0;
		for (const t of page.longtasks) {
			const a = Math.max(t.t, lo);
			const b = Math.min(t.t + t.ms, i.done);
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
			hydrate_ms: round(Math.max(0, i.done - lo)),
			t0: i.t0,
			done: i.done,
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
	const recovered = rows.filter((r) => r.recovered);
	if (recovered.length)
		findings.push({
			code: 'recovered',
			severity: 'error',
			message: `${list(recovered.map((r) => r.name))} threw away the server HTML and rendered again in the browser (a flash and a double render). Something changed the markup between the server and hydration.`,
			fix: 'Look for a script that edits the page before islands wake (an A/B tool, a DOM injector), or markup the browser rewrites (invalid nesting like a <div> in a <p>).',
			fps: recovered.map((r) => r.fp)
		});

	// ── the markup changed on hydration (no recovery: Svelte patched it in place) ──
	const changed = rows.filter((r) => r.changed && !r.recovered);
	if (changed.length) {
		const snap = page.snapshots?.find((s) => s.fp === changed[0].fp);
		const d = snap ? first_difference(snap.ssr, snap.hydrated) : null;
		findings.push({
			code: 'markup-changed',
			severity: 'warn',
			message:
				`${list(changed.map((r) => r.name))} rendered different markup in the browser than on the server, so the page changes as it wakes.` +
				(d ? ` First difference in ${changed[0].name}: server "${clip(d.server)}", browser "${clip(d.now)}".` : ''),
			fix: 'Render the same thing on both sides: move time, random values, and browser-only reads (window, localStorage) into an effect or an event, or pass them in as props.',
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
		findings.push({
			code: 'queued',
			severity: 'info',
			message:
				`${list(queued.map((r) => `${r.name} (${r.queue_ms} ms)`))} had its code but waited for its turn` +
				(top.length && top[0][1] >= 10
					? `, behind ${list(top.map(([n, m]) => `${n} (${Math.round(m)} ms)`))}: islands hydrate one per task, viewport first.`
					: ': islands hydrate after the page is parsed and painted, one per task, viewport first.'),
			fix: 'The islands ahead of it are the cost. Make them lighter, or move islands that are not needed at load to wake=\'visible\' or \'idle\'.',
			fps: queued.map((r) => r.fp)
		});
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
	if (slow.length)
		findings.push({
			code: 'slow-module',
			severity: 'info',
			message: `${list(slow.map((r) => `${r.name} (${r.load_ms} ms)`))} waited a long time for its code to arrive.`,
			fix: 'Check the island\'s imports in the Bytes tab: a big dependency, or a chain of imports loaded one after another. (Dev serves modules one by one; a build is faster.)',
			fps: slow.map((r) => r.fp)
		});

	// ── eager islands below the fold ──
	const eager_below = regions.filter((r) => r.kind === 'island' && EAGER.has(r.wake) && vh && typeof r.top === 'number' && r.top >= vh);
	if (eager_below.length)
		findings.push({
			code: 'eager-offscreen',
			severity: 'info',
			message: `${list(eager_below.map((r) => r.name))} start${eager_below.length === 1 ? 's' : ''} below the first screen but load${eager_below.length === 1 ? 's' : ''} code at page load.`,
			fix: "Use wake='visible': its code loads when it scrolls into view, and the islands on the first screen wake sooner.",
			fps: eager_below.map((r) => r.fp)
		});

	// ── looked ready long before it worked ──
	const lcp = page.visit?.paints?.lcp ?? page.vitals.lcp;
	if (typeof lcp === 'number') {
		const late = rows.filter((r) => EAGER.has(r.wake) && !r.below_fold && r.done - lcp >= LATE_MS);
		if (late.length)
			findings.push({
				code: 'late-interactive',
				severity: 'warn',
				message: `${list(late.map((r) => `${r.name} (${Math.round(r.done - lcp)} ms)`))} on the first screen woke long after the page looked finished (LCP ${Math.round(lcp)} ms). A visitor can click it and get nothing in that gap.`,
				fix: 'Shrink what it loads and what hydrates before it, or render it as plain HTML (a lake) if it does not need to be interactive at once.',
				fps: late.map((r) => r.fp)
			});
		// the largest paint sat in an island that changed on hydration: the LCP repaints
		const lcp_fp = page.visit?.paints?.lcp_fp;
		const hit = lcp_fp ? rows.find((r) => r.fp === lcp_fp) : undefined;
		if (hit && (hit.changed || hit.recovered))
			findings.push({
				code: 'lcp-repaint',
				severity: 'warn',
				message: `The largest paint (${page.visit?.paints?.lcp_tag ?? 'element'}) is inside ${hit.name}, which changed its markup on hydration — the biggest thing on screen repaints as it wakes.`,
				fix: 'Make the island render the same markup on both sides (see the markup finding), or keep the hero out of the island.',
				fps: [hit.fp]
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
		findings.push({
			code: `vital-${v.key}`,
			severity: v.rating === 'poor' ? 'warn' : 'info',
			message: `${v.label} is ${v.key === 'cls' ? v.value : `${Math.round(v.value)} ms`} (${v.rating === 'poor' ? 'poor' : 'needs work'}; good is ${v.key === 'cls' ? '≤ ' + LIMITS[v.key][0] : '≤ ' + LIMITS[v.key][0] + ' ms'}).`,
			fps: v.key === 'lcp' && page.visit?.paints?.lcp_fp ? [page.visit.paints.lcp_fp] : []
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
	if (held_ms >= 200)
		findings.push({
			code: 'render-blocking',
			severity: held_ms >= 600 ? 'warn' : 'info',
			message: `${blocking.length} file${blocking.length === 1 ? '' : 's'} blocked the first paint for ${Math.round(held_ms)} ms after the HTML arrived; the slowest took ${Math.round(blocking[0].ms)} ms (${short(blocking[0].url)}).`,
			fix: 'Inline small stylesheets, merge the rest, and load scripts as modules (they do not block).',
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
