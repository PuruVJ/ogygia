/**
 * What a recorded session (session.ts) says — pure, so it tests on plain data. Findings point back
 * at the page: an interaction's target, a shift's element, an island (the tab resolves the refs).
 * The CPU trace, when there is one, names the function behind a slow interaction or a long task
 * (cpu.ts, with each interaction as its own window); long animation frames name the script when
 * the sampler could not run.
 */
import { analyze_cpu, fn_label, is_trace, type CpuSummary } from './cpu.js';
import type { SessionData } from './session.js';

export type Ref = { kind: 'interaction'; i: number } | { kind: 'click'; i: number } | { kind: 'shift'; i: number } | { kind: 'island'; fp: string };

export interface SessionFinding {
	code: string;
	severity: 'error' | 'warn' | 'info';
	message: string;
	fix?: string;
	refs: Ref[];
	/** a same-origin GET the tab can profile on the server in one click (server-time findings) */
	url?: string;
}

/** One island's part of the session: what was done to it, and what it asked the server. */
export interface IslandSession {
	clicks: number;
	/** its interactions over 100 ms */
	slow: { target: string; duration: number; processing: number }[];
	/** requests that started within 3 s after a click on it, with the server's split */
	requests: { url: string; ms: number; server_ms: number | null; net_ms: number | null; up: string | null; status: number | null }[];
	mutations: number;
}

/** One item on the session's one-clock timeline (ms from the session start). */
export interface TimelineItem {
	t0: number;
	t1: number;
	label: string;
	tone: 'ok' | 'warn' | 'bad' | 'info';
	/** a request: the server's part and, inside it, the upstream wait (ms) */
	server?: { ms: number; up: number };
	ref?: Ref;
}
export interface TimelineLane {
	key: 'input' | 'main' | 'net' | 'islands' | 'layout' | 'errors';
	label: string;
	items: TimelineItem[];
}

/** The session on one clock, lane by lane (the Record tab draws it). Capped per lane. */
export function session_timeline(s: SessionData, names: (fp: string) => string): TimelineLane[] {
	const z = s.from;
	const cap = <T>(xs: T[]) => xs.slice(0, 300);
	const input: TimelineItem[] = [];
	s.clicks.forEach((c, i) => input.push({ t0: c.t - z, t1: c.t - z, label: `click ${c.target}`, tone: 'info', ref: { kind: 'click', i } }));
	const seen = new Set<number>();
	s.interactions.forEach((x, i) => {
		if (!x.id || seen.has(x.id)) return;
		seen.add(x.id);
		input.push({
			t0: x.t - z,
			t1: x.t - z + x.duration,
			label: `${x.name} ${x.target} — ${Math.round(x.duration)} ms (handlers ${Math.round(x.processing)} ms)`,
			tone: x.duration >= SLOW ? 'bad' : x.duration >= SLUGGISH ? 'warn' : 'ok',
			ref: { kind: 'interaction', i }
		});
	});
	const main: TimelineItem[] = s.longtasks.map((t) => ({ t0: t.t - z, t1: t.t - z + t.ms, label: `long task ${Math.round(t.ms)} ms`, tone: t.ms >= 200 ? 'bad' : 'warn' }));
	const net: TimelineItem[] = s.requests.map((r) => {
		const ssr = r.server?.find((x) => x.name === 'ssr')?.ms;
		const up = r.server?.find((x) => x.name === 'net')?.ms ?? 0;
		let path = r.url;
		try {
			path = new URL(r.url).pathname;
		} catch {
			// keep
		}
		return {
			t0: r.t - z,
			t1: r.t - z + r.ms,
			label: `${path} — ${Math.round(r.ms)} ms${ssr !== undefined ? ` (server ${Math.round(ssr)} ms${up ? `, waiting ${Math.round(up)} ms` : ''})` : ''}${r.status && r.status >= 400 ? ` · ${r.status}` : ''}`,
			tone: r.status !== null && r.status >= 400 ? 'bad' : r.ms >= 1000 ? 'warn' : 'info',
			...(ssr !== undefined ? { server: { ms: ssr, up } } : {})
		};
	});
	const islands: TimelineItem[] = [];
	// the documents the session crossed (a full page load mid-session)
	for (const p of (s.pages ?? []).slice(1)) islands.push({ t0: p.t - z, t1: p.t - z, label: `page load: ${p.url}`, tone: 'info' });
	const hyd = new Map<string, number>();
	for (const e of s.events) if (e.name === 'region.hydrate.done' && e.fp) hyd.set(e.fp, e.t);
	for (const e of s.events) {
		const fp = (e as { fp?: string }).fp;
		if (e.name === 'wake.fired' && fp)
			islands.push({ t0: e.t - z, t1: (hyd.get(fp) ?? e.t) - z, label: `${names(fp)} woke (${(e as { when?: string }).when ?? ''})`, tone: 'ok', ref: { kind: 'island', fp } });
		else if (e.name === 'region.hydrate.failed' && fp) islands.push({ t0: e.t - z, t1: e.t - z, label: `${names(fp)} failed to hydrate`, tone: 'bad', ref: { kind: 'island', fp } });
		else if (e.name === 'nav.finish') islands.push({ t0: e.t - e.ms - z, t1: e.t - z, label: `navigation to ${e.to} — ${Math.round(e.ms)} ms`, tone: e.ms >= 500 ? 'warn' : 'info' });
	}
	const layout: TimelineItem[] = s.shifts.map((x, i) => ({ t0: x.t - z, t1: x.t - z, label: `layout shift ${x.value}${x.input ? ' (after input)' : ''}${x.fp ? ` in ${names(x.fp)}` : ''}`, tone: x.input ? 'info' : x.value >= 0.05 ? 'bad' : 'warn', ref: { kind: 'shift', i } }));
	const errors: TimelineItem[] = s.errors.map((e) => ({ t0: e.t - z, t1: e.t - z, label: e.message, tone: 'bad' }));
	return (
		[
			{ key: 'input', label: 'input', items: cap(input) },
			{ key: 'main', label: 'main thread', items: cap(main) },
			{ key: 'net', label: 'requests', items: cap(net) },
			{ key: 'islands', label: 'islands · nav', items: cap(islands) },
			{ key: 'layout', label: 'layout', items: cap(layout) },
			{ key: 'errors', label: 'errors', items: cap(errors) }
		] as TimelineLane[]
	).filter((l) => l.items.length);
}

export interface SessionReport {
	duration_ms: number;
	counts: { interactions: number; slow: number; longtasks: number; longtask_ms: number; requests: number; request_bytes: number; errors: number; shifts: number; mutations: number; pages: number };
	findings: SessionFinding[];
	/** the slowest interactions, for the timeline */
	interactions: { i: number; t: number; name: string; duration: number; target: string; fp: string | null }[];
	/** each island's part: clicks, slow interactions, the requests its clicks caused (server split) */
	by_island: Record<string, IslandSession>;
	/** the slowest requests, with the server's own split when it sent one */
	requests: { url: string; ms: number; status: number | null; server_ms: number | null; cpu_ms: number | null; net_ms: number | null; up: string | null }[];
	cpu: CpuSummary | null;
}

const ms = (n: number) => (n >= 1000 ? (n / 1000).toFixed(2) + ' s' : Math.round(n) + ' ms');
const kb = (n: number) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const path_of = (u: string) => {
	try {
		const x = new URL(u);
		return x.pathname + (x.search.length > 1 ? x.search.slice(0, 40) : '');
	} catch {
		return u;
	}
};

/** a GET on this page's own origin (the profiler can render only those) */
function same_origin_get(url: string, page_url: string): boolean {
	try {
		return new URL(url).origin === new URL(page_url).origin && !url.includes('/__profiler');
	} catch {
		return false;
	}
}

/** Slow from here (Event Timing duration, ms): Google's INP lines. */
const SLOW = 200;
const SLUGGISH = 100;

export function analyze_session(s: SessionData, names: (fp: string) => string, page_url: string): SessionReport {
	const findings: SessionFinding[] = [];
	const name_of = (fp: string | null) => (fp ? names(fp) : 'the page');

	// ── interactions: one per interaction id (its slowest event), plus pointer-less ones ──
	// (one interaction = pointerdown + pointerup + click: its length is the longest, its split is the
	// event whose handlers did the work — a slow click handler shows on the pointerdown only as paint)
	const by_id = new Map<number, number>();
	const longest = new Map<number, number>();
	s.interactions.forEach((x, i) => {
		if (!x.id) return;
		longest.set(x.id, Math.max(longest.get(x.id) ?? 0, x.duration));
		const prev = by_id.get(x.id);
		const p = prev === undefined ? null : s.interactions[prev];
		if (!p || x.processing > p.processing || (x.processing === p.processing && x.duration > p.duration)) by_id.set(x.id, i);
	});
	for (const [id, i] of by_id) s.interactions[i] = { ...s.interactions[i], duration: longest.get(id) ?? s.interactions[i].duration };
	const chosen = [...by_id.values()];

	// the CPU trace, with each chosen interaction as a window (its top functions), long tasks outside
	let cpu: CpuSummary | null = null;
	if (is_trace(s.cpu)) {
		const windows = chosen.map((i) => ({ fp: 'ix:' + i, from: s.interactions[i].t, to: s.interactions[i].t + s.interactions[i].duration }));
		cpu = analyze_cpu(s.cpu, windows, s.longtasks, page_url);
	}
	const why = (i: number) => {
		const f = cpu?.islands['ix:' + i]?.top[0];
		if (f && f.self_ms >= 5) return `; mostly ${fn_label(f)}`;
		// no sampler: the long animation frame over it names the script
		const x = s.interactions[i];
		const frame = s.frames.find((fr) => fr.t <= x.t + x.duration && fr.t + fr.ms >= x.t && fr.scripts.length);
		const sc = frame?.scripts.slice().sort((a, b) => b.ms - a.ms)[0];
		return sc && sc.ms >= 5 ? `; mostly ${sc.invoker || sc.fn || 'a script'}${sc.source ? ` (${path_of(sc.source).split('/').pop()})` : ''}` : '';
	};

	const slow = chosen.filter((i) => s.interactions[i].duration >= SLUGGISH).sort((a, b) => s.interactions[b].duration - s.interactions[a].duration);
	for (const i of slow.slice(0, 5)) {
		const x = s.interactions[i];
		const part = x.processing >= x.input_delay && x.processing >= x.presentation ? 'processing' : x.input_delay >= x.presentation ? 'input' : 'paint';
		findings.push({
			code: 'slow-interaction',
			severity: x.duration >= SLOW ? 'warn' : 'info',
			message: `${x.name} on ${x.target}${x.fp ? ` in ${name_of(x.fp)}` : ''} took ${ms(x.duration)} to show a result (waiting ${ms(x.input_delay)} · handlers ${ms(x.processing)} · painting ${ms(x.presentation)})${why(i)}.`,
			fix:
				part === 'processing'
					? 'The handlers are the cost: do less before the next paint (update the screen first, then do the rest in a later task), or move the work off the main thread.'
					: part === 'input'
						? 'The click waited for other work to finish: something else held the main thread when it came (see the long tasks).'
						: 'Rendering the result is the cost: a big DOM change or an expensive style/layout after it. Change less at once.',
			refs: [{ kind: 'interaction', i }]
		});
	}

	// ── the same element clicked again and again, quickly: it looked unresponsive (every click, fast ones too) ──
	const rage: number[] = [];
	for (let a = 0; a < s.clicks.length; a++) {
		let n = 1;
		for (let b = a + 1; b < s.clicks.length && s.clicks[b].t - s.clicks[a].t < 1000; b++) if (s.clicks[b].target === s.clicks[a].target) n++;
		if (n >= 3 && !rage.some((r) => s.clicks[r].target === s.clicks[a].target)) rage.push(a);
	}
	for (const i of rage)
		findings.push({
			code: 'rage-click',
			severity: 'warn',
			message: `${s.clicks[i].target}${s.clicks[i].fp ? ` in ${name_of(s.clicks[i].fp)}` : ''} was clicked 3+ times within a second: to a visitor it looked like nothing happened.`,
			fix: 'Show a reaction at once (a pressed state, a spinner), and make sure the click is handled.',
			refs: [{ kind: 'click', i }]
		});

	// ── a click that changed nothing, or answered only late. In an island: its own DOM changes (within
	// 3 s it answered — late past 500 ms; none = dead). Outside islands: any change but in the islands
	// other clicks just hit, any request, a navigation — within 500 ms ──
	const navs = s.events.filter((e) => e.name === 'nav.start').map((e) => e.t);
	const raged = new Set(rage.map((r) => s.clicks[r].target));
	const dead: number[] = [];
	const late: { i: number; after: number }[] = [];
	s.clicks.forEach((c, i) => {
		if (raged.has(c.target)) return;
		if (c.fp) {
			const first = s.mut_log.find((m) => m.t >= c.t && m.t <= c.t + 3000 && m.fp === c.fp);
			if (!first && !navs.some((t) => t >= c.t && t <= c.t + 3000)) dead.push(i);
			else if (first && first.t - c.t > 500) late.push({ i, after: first.t - c.t });
			return;
		}
		const until = c.t + 500;
		const others = new Set(s.clicks.filter((o, j) => j !== i && o.t >= c.t && o.t <= until && o.fp).map((o) => o.fp));
		const changed = s.mut_log.some((m) => m.t >= c.t && m.t <= until && !others.has(m.fp));
		const asked = s.requests.some((r) => r.t >= c.t && r.t <= until) && !others.size;
		if (!changed && !asked && !navs.some((t) => t >= c.t && t <= until)) dead.push(i);
	});
	if (late.length)
		findings.push({
			code: 'late-feedback',
			severity: 'info',
			message: `${late.length} click${late.length === 1 ? '' : 's'} got no visible answer for a while: ${late
				.slice(0, 3)
				.map(({ i, after }) => `${s.clicks[i].target}${s.clicks[i].fp ? ` in ${name_of(s.clicks[i].fp)}` : ''} (${ms(after)})`)
				.join(', ')}.`,
			fix: 'Show a reaction at once — a pressed or loading state — and then the result.',
			refs: late.slice(0, 6).map(({ i }) => ({ kind: 'click' as const, i }))
		});
	if (dead.length)
		findings.push({
			code: 'dead-click',
			severity: 'info',
			message: `${dead.length} click${dead.length === 1 ? '' : 's'} changed nothing on the page (no DOM change, no request, no navigation): ${[...new Set(dead.map((i) => s.clicks[i].target))].slice(0, 3).join(', ')}.`,
			fix: 'If it should do something, its handler is missing (an island that never woke, plain HTML with no JS) or it failed silently.',
			refs: dead.slice(0, 6).map((i) => ({ kind: 'click' as const, i }))
		});

	// ── long tasks ──
	const lt_ms = s.longtasks.reduce((a, t) => a + t.ms, 0);
	if (s.longtasks.length) {
		const f = cpu?.outside.top[0];
		findings.push({
			code: 'long-tasks',
			severity: lt_ms >= 300 ? 'warn' : 'info',
			message: `${s.longtasks.length} long task${s.longtasks.length === 1 ? '' : 's'} held the main thread for ${ms(lt_ms)} in all (the longest ${ms(Math.max(...s.longtasks.map((t) => t.ms)))})${f && f.self_ms >= 5 ? `; outside the interactions, mostly ${fn_label(f)}` : ''}.`,
			refs: []
		});
	}

	// ── layout shifts nobody caused ──
	const unexpected = s.shifts.map((x, i) => ({ x, i })).filter(({ x }) => !x.input);
	const cls = unexpected.reduce((a, { x }) => a + x.value, 0);
	if (cls >= 0.02)
		findings.push({
			code: 'unexpected-shift',
			severity: cls >= 0.1 ? 'warn' : 'info',
			message: `The layout moved by itself (no input) ${unexpected.length} time${unexpected.length === 1 ? '' : 's'}, CLS ${Math.round(cls * 1000) / 1000}${unexpected[0]?.x.fp ? `, first in ${name_of(unexpected[0].x.fp)}` : ''}.`,
			fix: 'Reserve space for what arrives late (images, holes, islands that grow as they wake).',
			refs: unexpected.slice(0, 6).map(({ i }) => ({ kind: 'shift' as const, i }))
		});

	// ── requests ──
	const bytes = s.requests.reduce((a, r) => a + r.bytes, 0);
	const failed = s.requests.filter((r) => r.status !== null && r.status >= 400);
	if (failed.length)
		findings.push({
			code: 'failed-requests',
			severity: 'warn',
			message: `${failed.length} request${failed.length === 1 ? '' : 's'} failed: ${failed.slice(0, 3).map((r) => `${r.status} ${path_of(r.url)}`).join(', ')}.`,
			refs: []
		});
	const slow_req = s.requests.filter((r) => r.ms >= 1000).sort((a, b) => b.ms - a.ms);
	if (slow_req.length)
		findings.push({
			code: 'slow-requests',
			severity: 'info',
			message: `${slow_req.length} request${slow_req.length === 1 ? '' : 's'} took over a second: ${slow_req.slice(0, 3).map((r) => `${path_of(r.url)} ${ms(r.ms)}`).join(', ')}.`,
			refs: []
		});
	const by_url = new Map<string, number>();
	for (const r of s.requests) if (r.type === 'fetch' || r.type === 'xmlhttprequest') by_url.set(path_of(r.url), (by_url.get(path_of(r.url)) ?? 0) + 1);
	const repeated = [...by_url].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
	if (repeated.length)
		findings.push({
			code: 'repeated-requests',
			severity: 'info',
			message: `The same request went out again and again: ${repeated.slice(0, 3).map(([u, n]) => `${u} ×${n}`).join(', ')}.`,
			fix: 'Cache the answer, or share one request between the parts that ask.',
			refs: []
		});

	// ── the server's side of each request (its Server-Timing): render, CPU, the upstream it waited on ──
	const st = (r: (typeof s.requests)[number], name: string) => r.server?.find((x) => x.name === name);
	const served = s.requests.filter((r) => st(r, 'ssr')).sort((a, b) => (st(b, 'ssr')?.ms ?? 0) - (st(a, 'ssr')?.ms ?? 0));
	for (const r of served.slice(0, 3)) {
		const ssr = st(r, 'ssr')!.ms;
		if (ssr < 200) break;
		const cpu_ms = st(r, 'cpu')?.ms;
		const net = st(r, 'net');
		const up = st(r, 'up1');
		findings.push({
			code: 'server-time',
			severity: ssr >= 500 ? 'warn' : 'info',
			message:
				`${path_of(r.url)} took ${ms(r.ms)}: ${ms(ssr)} on the server` +
				(cpu_ms !== undefined ? ` (${ms(cpu_ms)} of CPU)` : '') +
				(net ? `, ${ms(net.ms)} of it waiting on ${net.desc.split('(')[1]?.split(')')[0] ?? 'several'} outbound call${net.desc.includes('(1)') ? '' : 's'}${up ? ` — the slowest ${up.desc} ${ms(up.ms)}` : ''}` : '') +
				`, ${ms(Math.max(0, r.ms - ssr))} on the network.`,
			fix: net && net.ms >= ssr * 0.5 ? 'The server mostly waited: start the calls together, cache the answer, or move the call out of this request.' : 'Profile it on the server (the button) to see where its time went.',
			refs: (() => {
				// the click that caused it, when one came just before
				const c = s.clicks.filter((x) => x.t <= r.t && r.t - x.t <= 3000).at(-1);
				return c ? [{ kind: 'click' as const, i: s.clicks.indexOf(c) }] : [];
			})(),
			...(same_origin_get(r.url, page_url) ? { url: r.url } : {})
		});
	}

	// ── per island: its clicks, its slow interactions, the requests its clicks caused (with the
	// server's split) — the island detail's "in the last session" ──
	const by_island: Record<string, IslandSession> = {};
	const slot = (fp: string) => (by_island[fp] ??= { clicks: 0, slow: [], requests: [], mutations: 0 });
	for (const c of s.clicks) if (c.fp) slot(c.fp).clicks++;
	for (const i of chosen) {
		const x = s.interactions[i];
		if (x.fp && x.duration >= SLUGGISH) slot(x.fp).slow.push({ target: x.target, duration: x.duration, processing: x.processing });
	}
	for (const r of s.requests) {
		const c = s.clicks.filter((x) => x.t <= r.t && r.t - x.t <= 3000).at(-1);
		if (!c?.fp) continue;
		slot(c.fp).requests.push({ url: path_of(r.url), ms: r.ms, server_ms: st(r, 'ssr')?.ms ?? null, net_ms: st(r, 'net')?.ms ?? null, up: st(r, 'up1') ? `${st(r, 'up1')!.desc} ${ms(st(r, 'up1')!.ms)}` : null, status: r.status });
	}
	for (const m of s.mutations) if (m.fp && by_island[m.fp]) by_island[m.fp].mutations = m.count;

	// ── islands: woken, failed, recovered, healed during the session ──
	const woke = s.events.filter((e) => e.name === 'wake.fired');
	if (woke.length) {
		const done = new Map<string, number>();
		for (const e of s.events) if (e.name === 'region.hydrate.done' && e.fp) done.set(e.fp, e.ms);
		const list = woke.map((e) => ((e as { fp?: string }).fp ? `${name_of((e as { fp?: string }).fp!)}${done.has((e as { fp?: string }).fp!) ? ` (${ms(done.get((e as { fp?: string }).fp!)!)})` : ''}` : 'an island'));
		findings.push({
			code: 'islands-woke',
			severity: 'info',
			message: `${woke.length} island${woke.length === 1 ? '' : 's'} woke during the session: ${[...new Set(list)].slice(0, 5).join(', ')}.`,
			refs: woke.filter((e) => (e as { fp?: string }).fp).slice(0, 6).map((e) => ({ kind: 'island' as const, fp: (e as { fp?: string }).fp! }))
		});
	}
	for (const e of s.events) {
		if (e.name === 'region.hydrate.failed')
			findings.push({ code: 'hydrate-failed', severity: 'error', message: `${name_of(e.fp ?? null)} failed to hydrate: ${e.message.split('\n')[0].slice(0, 160)}.`, refs: e.fp ? [{ kind: 'island', fp: e.fp }] : [] });
		else if (e.name === 'region.hydrate.recovered')
			findings.push({ code: 'hydrate-recovered', severity: 'error', message: `${name_of(e.fp ?? null)} threw away its server HTML and rendered again${e.reason ? `: ${e.reason}` : ''}.`, refs: e.fp ? [{ kind: 'island', fp: e.fp }] : [] });
		else if (e.name === 'region.hydrate.healed')
			findings.push({ code: 'hydrate-healed', severity: 'warn', message: `${name_of(e.fp ?? null)}'s markup was changed by another script before it woke; the runtime put the server markup back${e.reason ? ` (${e.reason})` : ''}.`, refs: e.fp ? [{ kind: 'island', fp: e.fp }] : [] });
	}

	// ── errors ── (ogygia's own log of a failed island is the hydrate-failed finding above, with its
	// name: not counted again; each message by its first line — a component stack follows it)
	const failed_here = s.events.some((e) => e.name === 'region.hydrate.failed');
	const errors = failed_here ? s.errors.filter((e) => !e.message.startsWith('console.error: [ogygia] hydration failed')) : s.errors;
	if (errors.length)
		findings.push({
			code: 'errors',
			severity: 'error',
			message: `${errors.length} error${errors.length === 1 ? '' : 's'}: ${[...new Set(errors.map((e) => e.message.split('\n')[0].trim()))].slice(0, 3).join(' · ')}.`,
			refs: []
		});

	// ── the DOM changing a lot ──
	for (const m of s.mutations.slice(0, 3)) {
		if (m.count < 300) break;
		findings.push({
			code: 'dom-churn',
			severity: 'info',
			message: `${m.fp ? name_of(m.fp) : 'Code outside any island'} changed the DOM ${m.count} times during the session${m.fp ? '' : ' (page scripts, a third-party tag)'}.`,
			fix: 'Lots of small changes often mean a re-render on every event: batch them, or key the list so unchanged rows stay.',
			refs: m.fp ? [{ kind: 'island', fp: m.fp }] : []
		});
	}

	// ── the heap ──
	if (s.heap && s.heap.to - s.heap.from >= 5 * 1048576)
		findings.push({
			code: 'heap-growth',
			severity: 'info',
			message: `The JS heap grew by ${kb(s.heap.to - s.heap.from)} during the session (${kb(s.heap.from)} → ${kb(s.heap.to)}). If it keeps growing across the same actions, something is kept (a listener, a cache, a closed island's state).`,
			refs: []
		});

	// ── navigations ──
	for (const e of s.events) {
		if (e.name !== 'nav.finish') continue;
		if (e.ms >= 500)
			findings.push({
				code: 'slow-navigation',
				severity: 'info',
				message: `The navigation to ${e.to} took ${ms(e.ms)}${e.reconciled ? '' : ' (a full swap, not reconciled)'}.`,
				refs: []
			});
	}

	const order = { error: 0, warn: 1, info: 2 };
	findings.sort((a, b) => order[a.severity] - order[b.severity]);
	return {
		duration_ms: Math.round(s.to - s.from),
		counts: {
			interactions: chosen.length,
			slow: slow.length,
			longtasks: s.longtasks.length,
			longtask_ms: Math.round(lt_ms),
			requests: s.requests.length,
			request_bytes: bytes,
			errors: s.errors.length,
			shifts: unexpected.length,
			mutations: s.mutations.reduce((a, m) => a + m.count, 0),
			pages: Math.max(1, s.pages?.length ?? 1)
		},
		findings,
		interactions: chosen
			.map((i) => ({ i, t: s.interactions[i].t, name: s.interactions[i].name, duration: s.interactions[i].duration, target: s.interactions[i].target, fp: s.interactions[i].fp }))
			.sort((a, b) => b.duration - a.duration)
			.slice(0, 12),
		by_island,
		requests: [...s.requests]
			.filter((r) => r.type === 'fetch' || r.type === 'xmlhttprequest' || r.server?.length)
			.sort((a, b) => b.ms - a.ms)
			.slice(0, 12)
			.map((r) => ({
				url: path_of(r.url),
				ms: r.ms,
				status: r.status,
				server_ms: st(r, 'ssr')?.ms ?? null,
				cpu_ms: st(r, 'cpu')?.ms ?? null,
				net_ms: st(r, 'net')?.ms ?? null,
				up: st(r, 'up1') ? `${st(r, 'up1')!.desc} ${ms(st(r, 'up1')!.ms)}` : null
			})),
		cpu
	};
}
