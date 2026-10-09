// AFTER ALL OF IT: what one render would take with every fix the report names, estimated without
// counting one saving twice. Fixes that touch the same line (a formatter built per call is also the
// "library per item" on that line; one slow call is "same answer" AND "waits in a row") overlap:
// such a group gives back its largest saving, not their sum. Groups that share nothing add up —
// two chains of waits one after the other, a loop here and a parse there. Work whose data nothing
// reads is deleted outright, and any pattern inside it is moot. Keeping a service's answer for
// later renders is told apart: it trades freshness for time, a decision the code fixes do not need.

import type { DrillNode } from './drill.js';
import type { Pattern, PatternKind } from './patterns.js';
import type { CallStack } from './analyze.js';
import { tokens } from './source-scan.js';
import { saving_of } from './saving.js';

export { saving_of };

export interface Forecast {
	/** one render now: the median of the profiled renders, ms, as the app paid it */
	now_ms: number;
	/** one render with every fix below, ms (an estimate) */
	after_ms: number;
	/** what the render used, which capped the savings: its waiting and its CPU, ms (the compare's
	 *  fix check counts a later report's fixes the same way) */
	caps?: { wait?: number; cpu?: number };
	/** the parts of the saving: CPU, waiting, and work deleted, ms per render */
	cpu_ms: number;
	wait_ms: number;
	delete_ms: number;
	/** the main thread's CPU a render, now and after every fix (ms): what bounds how many renders a
	 *  core serves — the waiting fixes cut the time a visitor waits, only the CPU ones raise that */
	cpu_now_ms?: number;
	cpu_after_ms?: number;
	/** the fixes counted, biggest first; `with`: the other fixes on the same lines, whose saving
	 *  this one already covers; `after_ms`: one render once this fix AND every one above it is done */
	parts: {
		title: string;
		kind: string;
		ms: number;
		wait: boolean;
		after_ms?: number;
		with?: string[];
	}[];
	/** caching the services' answers on top (same answer every render): one render after that, and
	 *  those fixes. A decision about how stale an answer may be, so left out of `after_ms` */
	answers?: {
		after_ms: number;
		wait_ms: number;
		parts: Forecast['parts'];
		clamped?: boolean;
		/** the page was rendered with those answers served from memory: `ms` is that render (the
		 *  median of `renders`), and `after_ms` is it with the code fixes the caching does not cover
		 *  taken off; `model_ms` what the lines alone estimated */
		measured?: { ms: number; renders: number; model_ms: number };
	};
	/** the whole document is cacheable: a cached copy costs the render nothing — a different lever,
	 *  left out of `after_ms` */
	cache?: boolean;
	/** the savings claimed more waiting or CPU than the render had (they overlap in ways the lines
	 *  do not show): each was held at what the render used */
	clamped?: boolean;
	/** the build had no sourcemaps: the profiler saw fewer lines, so fewer fixes — the real time
	 *  after them is likely lower */
	partial?: boolean;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const place = (p: string) => (p.startsWith('src/') ? p.slice(4) : p);

export interface ForecastInputs {
	/** the waiting on one render's critical path — whatever the wait fixes claim, together they
	 *  cannot take off more than the render waited */
	wait_cap?: number;
	/** the app's CPU in one render: every CPU saving together cannot take off more */
	cpu_cap?: number;
	/** a function's heaviest call paths (functions table key → stacks): which work runs only
	 *  inside a call another fix takes out of the request */
	stacks?: (fn: string) => readonly CallStack[] | undefined;
	/** the page rendered with its same-every-time answers served from memory (ms per render) */
	answers_runs?: readonly number[];
	/** the main thread's CPU in one render: the sampled stacks (app, components, packages, Node) and
	 *  the collector's pauses there */
	cpu_main?: number;
}

export function forecast_of(
	runs: readonly number[] | undefined,
	patterns: readonly Pattern[] | undefined,
	drill: DrillNode | undefined,
	inputs: ForecastInputs = {}
): Forecast | undefined {
	const { wait_cap, cpu_cap, stacks } = inputs;
	if (!runs?.length) return undefined;
	const sorted = [...runs].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	const now = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	const n = runs.length;
	/** one saving: a pattern's fix, or deleting work for data nothing reads, with the lines it
	 *  stands on (what it shares with another saving) */
	type Item = {
		title: string;
		kind: string;
		ms: number;
		wait: boolean;
		keys: string[];
		p?: Pattern;
		calls?: Set<string>;
		/** keys that join it to a FIX but not to another deletion: the line rows above a deleted row
		 *  (two unread calls under one shared helper line are two deletions, both counted) */
		soft?: Set<string>;
	};
	const items: Item[] = [];
	// WORK FOR DATA NOTHING READS: the topmost such rows, deleted — every line under them is gone (a
	// pattern there is moot), and each is a saving that shares its lines AND the line rows above it:
	// deleting one call of a chain that "waits in a row" also fixes, saves little once the chain's
	// calls run together, so the two are one group
	const gone = new Set<string>();
	const unread = (d: DrillNode, above: string[], waiting: boolean) => {
		const in_wait = waiting || d.kind === 'wait';
		if (d.fills?.length && d.fills.every((f) => !f.read)) {
			// (its own name first: a key only it has, for fixes that join it)
			const keys: string[] = [`unread\0${items.length}`, ...above];
			const all_lines = (m: DrillNode) => {
				if (m.at) {
					gone.add(place(m.at));
					keys.push(place(m.at));
				}
				for (const c of m.children ?? []) all_lines(c);
			};
			all_lines(d);
			// the functions its lines call (`…sort((a, b) => newestReview(b.reviews) …)`): a fix inside
			// one of them is inside this work too, when V8 inlined it onto the line
			// (the names CALLED on them: `newestReview(` — not every word, a property like `.map` or
			// `.format` would join an unrelated fix of that name)
			const names = new Set<string>();
			const called = (m: DrillNode) => {
				if (m.code) {
					const t = tokens(m.code);
					for (let k = 0; k + 1 < t.length; k++)
						if (t[k + 1] === '(' && t[k - 1] !== '.' && t[k - 1] !== '?.') names.add(t[k]);
				}
				for (const c of m.children ?? []) called(c);
			};
			called(d);
			items.push({
				title: `Delete work for data nothing reads (${d.fills.map((f) => f.key).join(', ')})`,
				kind: 'unread-work',
				ms: d.ms,
				wait: in_wait,
				keys,
				calls: names,
				soft: new Set(above)
			});
			return;
		}
		const next = d.kind === 'line' && d.at ? [...above, place(d.at)] : above;
		for (const c of d.children ?? []) unread(c, next, in_wait);
	};
	if (drill) unread(drill, [], false);
	// ONE DELETION PER SET OF KEYS: the same unread data shows in several rows of the tree (the
	// helper's own CPU, the load line it was inlined onto, the collection its garbage caused) — rows
	// of different time, all gone with the one deletion: added up, one saving
	for (let i = 0; i < items.length; i++) {
		const a = items[i];
		if (a.kind !== 'unread-work') continue;
		for (let j = items.length - 1; j > i; j--) {
			const b = items[j];
			if (b.kind !== 'unread-work' || b.title !== a.title || b.wait !== a.wait) continue;
			a.ms += b.ms;
			a.keys.push(...b.keys);
			for (const c of b.calls ?? []) (a.calls ??= new Set()).add(c);
			for (const s of b.soft ?? []) (a.soft ??= new Set()).add(s);
			items.splice(j, 1);
		}
	}
	let cache = false;
	for (const p of patterns ?? []) {
		if (p.kind === 'same-document' || p.kind === 'almost-same-document') {
			cache = true;
			continue;
		}
		const ms = (p.save_ms ?? 0) / (p.wait ? 1 : n);
		if (ms <= 0) continue;
		const key = (x: { file: string; line: number }) => place(`${x.file}:${x.line}`);
		if (
			p.sites.length &&
			p.sites.every(
				(s) => gone.has(key(s)) || (!!s.via?.length && s.via.every((v) => gone.has(key(v))))
			)
		)
			continue;
		const keys = new Set<string>();
		for (const s of p.sites) {
			keys.add(key(s));
			for (const v of s.via ?? []) keys.add(key(v));
		}
		items.push({ title: p.title ?? p.kind, kind: p.kind, ms, wait: !!p.wait, keys: [...keys], p });
	}
	// WORK A MOVE TAKES AWAY: a call moved out of the request (same every request) takes everything
	// it runs with it — a slow search inside `attachBrands(valid)` saves nothing more once that call
	// runs once at startup. A CPU fix whose every line runs only inside such a call (its function IS
	// the call, or 90 % of its time is under it on the stacks) joins the move's group
	for (const mover of items.filter((it) => it.kind === 'same-every-request')) {
		const moved = new Set(mover.p!.sites.flatMap((s) => s.moves ?? (s.fn_name ? [s.fn_name] : [])));
		if (!moved.size) continue;
		const under = (s: Pattern['sites'][number]) => {
			if (s.fn_name && moved.has(s.fn_name)) return true;
			const st = s.fn ? stacks?.(s.fn) : undefined;
			if (!st?.length) return false;
			const total = st.reduce((t, x) => t + x.ms, 0);
			const inside = st
				.filter((x) => x.frames.some((f) => moved.has(f.n)))
				.reduce((t, x) => t + x.ms, 0);
			return total > 0 && inside >= total * 0.9;
		};
		for (const it of items) {
			if (it === mover || it.wait || !it.p?.sites.length || !it.p.sites.every(under)) continue;
			it.keys.push(mover.keys[0]);
		}
	}
	// ...and work a deletion takes away: a CPU fix whose every site's function is called on the
	// deleted lines joins that deletion's group
	for (const del of items.filter((it) => it.kind === 'unread-work' && it.calls?.size && !it.wait)) {
		for (const it of items) {
			if (
				!it.p ||
				it.wait ||
				!it.p.sites.length ||
				!it.p.sites.every((s) => !!s.fn_name && del.calls!.has(s.fn_name))
			)
				continue;
			it.keys.push(del.keys[0]);
		}
	}
	/** the saving of a set of fixes: grouped by shared lines (a union of every pattern that touches
	 *  a line another touches), CPU and waits apart — a line's wait and its CPU are different time */
	const saving = (set: Item[]) => {
		const parent = set.map((_, i) => i);
		const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
		// every item on each key; two deletions sharing only a line ABOVE them (a soft key) stay apart
		const owners = new Map<string, number[]>();
		set.forEach((it, i) => {
			for (const k of it.keys) {
				const tag = `${it.wait ? 'w' : 'c'}\0${k}`;
				const on = owners.get(tag) ?? owners.set(tag, []).get(tag)!;
				for (const j of on) {
					const other = set[j];
					if (
						it.kind === 'unread-work' &&
						other.kind === 'unread-work' &&
						(it.soft?.has(k) || other.soft?.has(k))
					)
						continue;
					parent[find(i)] = find(j);
				}
				on.push(i);
			}
		});
		const groups = new Map<number, Item[]>();
		set.forEach((it, i) => {
			const g = find(i);
			(groups.get(g) ?? groups.set(g, []).get(g)!).push(it);
		});
		// one saving per group: its biggest; the others it covers
		const tops = [...groups.values()]
			.map((g) => {
				g.sort((a, b) => b.ms - a.ms);
				return { top: g[0], others: g.slice(1).map((x) => x.title) };
			})
			.sort((a, b) => b.top.ms - a.top.ms);
		/** what a set of groups takes off together. EACH RESOURCE CAPPED BY WHAT THE RENDER USED:
		 *  every saving on the clock (the wait fixes and the waits deleted) takes off at most the
		 *  render's waiting; every CPU saving at most its CPU. Past that they overlap in a way the
		 *  lines do not show */
		const together = (set: readonly Item[]) =>
			saving_of(set, { wait: wait_cap, cpu: cpu_cap }, now);
		// biggest first, each with the render after it AND every one above it: the groups share no
		// line, so the running total is honest — where to stop reads off the list
		const parts: Forecast['parts'] = tops.map(({ top, others }, i) => ({
			title: top.title,
			kind: top.kind,
			ms: r1(top.ms),
			wait: top.wait,
			after_ms: r1(together(tops.slice(0, i + 1).map((x) => x.top)).after),
			...(others.length ? { with: others } : {})
		}));
		return { ...together(tops.map((x) => x.top)), parts, tops };
	};
	const caching = (it: Item) => CACHING.has(it.kind as PatternKind);
	const code = saving(items.filter((it) => !caching(it)));
	const cached = items.some(caching) ? saving(items) : undefined;
	// KEEPING THE ANSWERS, MEASURED: the page rendered with them served from memory. What the
	// caching group covers (its waits, and the fixes on its lines) is in that render already; the
	// code fixes outside it come off it the same way they come off a render
	let measured: { after: number; ms: number; renders: number } | undefined;
	const ar = inputs.answers_runs;
	if (cached && ar?.length) {
		const s = [...ar].sort((a, b) => a - b);
		const h = s.length >> 1;
		const ms = s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
		const rest = cached.tops.filter((t) => !caching(t.top)).map((t) => t.top);
		measured = {
			after: saving_of(rest, { wait: wait_cap, cpu: cpu_cap }, ms).after,
			ms,
			renders: s.length
		};
	}
	const answers_after = measured?.after ?? cached?.after;
	if (!code.parts.length && !cached && !cache) return undefined;
	return {
		now_ms: r1(now),
		...(wait_cap !== undefined || cpu_cap !== undefined
			? {
					caps: {
						...(wait_cap !== undefined ? { wait: r1(wait_cap) } : {}),
						...(cpu_cap !== undefined ? { cpu: r1(cpu_cap) } : {})
					}
				}
			: {}),
		after_ms: r1(code.after),
		cpu_ms: r1(code.cpu),
		// THE MAIN THREAD'S CPU: the code on the sampled stacks and the collector's pauses on that
		// thread — what one core's renders a second ride on. The process's own CPU count also has the
		// collector's helper threads and the pool, on other cores
		...(inputs.cpu_main && inputs.cpu_main > 0
			? {
					cpu_now_ms: r1(inputs.cpu_main),
					cpu_after_ms: r1(
						Math.max(inputs.cpu_main * 0.03, inputs.cpu_main - code.cpu - code.del_cpu)
					)
				}
			: {}),
		wait_ms: r1(code.wait),
		delete_ms: r1(code.del),
		parts: code.parts,
		...(cached && answers_after !== undefined && answers_after < code.after - 0.5
			? {
					answers: {
						after_ms: r1(answers_after),
						wait_ms: r1(cached.wait),
						parts: cached.parts.filter((p) => CACHING.has(p.kind as PatternKind)),
						...(cached.clamped && !measured ? { clamped: true } : {}),
						...(measured
							? {
									measured: {
										ms: r1(measured.ms),
										renders: measured.renders,
										model_ms: r1(cached.after)
									}
								}
							: {})
					}
				}
			: {}),
		...(cache ? { cache: true } : {}),
		...(code.clamped ? { clamped: true } : {})
	};
}

/** fixes that keep an ANSWER for later renders: worth it only where the answer may be a little
 *  stale, so a decision about freshness, not a code fix — told apart from the rest */
const CACHING: ReadonlySet<PatternKind> = new Set<PatternKind>(['same-answer', 'almost-same-answer']);
