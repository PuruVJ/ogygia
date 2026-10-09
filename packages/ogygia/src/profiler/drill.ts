/**
 * THE DRILL-DOWN: where ONE render's milliseconds went, as a tree that adds up at every level.
 *
 *   render 722 ms
 *   ├─ hooks 231 ms            (a Kit phase)
 *   │  ├─ @acme/ui 150 ms   (a library, CPU)
 *   │  └─ processDsTags 68 ms  (your function, CPU)
 *   │     ├─ ds-ssr.ts:64 41 ms  (its lines)
 *   │     └─ …
 *   ├─ load functions 384 ms
 *   │  ├─ GET api/product/:id 111 ms (waiting, 16 calls)
 *   │  │  └─ +page.server.ts:24  (the line that made them)
 *   │  └─ …
 *
 * Built from the render's timeline (one render's window, CPU and waits on one clock), so a phase is
 * exactly the time it held; a wait that several calls shared is split evenly between them. Your
 * functions go one level further, into their lines (the ledger's shares of the function's CPU); a
 * call, into the line that made it. Small children fold into one "N more" row per level.
 */
import type { InnerFn, Segment, Timeline } from './timeline.js';
import { PHASE_LABEL, load_lane_of } from './timeline.js';
import type { LedgerLine } from './ledger.js';
import type { Pattern } from './patterns.js';

export interface DrillNode {
	label: string;
	ms: number;
	/** what the time was: CPU, waiting on calls, a gap nothing recorded, or a mix (a phase) */
	kind: 'render' | 'phase' | 'lane' | 'cpu' | 'wait' | 'gap' | 'line' | 'more';
	/** a place to open: `file:line` */
	at?: string;
	/** calls behind a wait row */
	calls?: number;
	/** a CPU owner row: its lowest and highest ms over the profiled renders (its noise) */
	runs?: [number, number];
	/** a CPU owner row: its ms in the COLD first render (module load, compile, first-call caches),
	 *  when that stands out against its warm renders */
	cold?: number;
	/** an HTTP wait row, on the calls' OWN clocks (summed over its calls, not the shared wall):
	 *  until the headers came, what the other side's Server-Timing claims of that (`theirs_ms`, over
	 *  `told` of the calls), the rest (`network_ms`: the network, TLS, their framework, a queue — or
	 *  all of it when they told nothing), and reading the body */
	split?: {
		calls: number;
		theirs_ms?: number;
		told?: number;
		network_ms: number;
		body_ms: number;
		top?: { name: string; ms: number }[];
	};
	/** the page-data keys this row's lines feed (lineage), and whether anything reads each */
	fills?: { key: string; read: boolean }[];
	/** a wait row: the ms nothing else was in flight (the render waited on this endpoint alone);
	 *  0 = always beside other calls, so a faster answer alone saves nothing */
	alone?: number;
	/** WHY: the slow patterns (their kinds) found on this row's line, or its lines' — the where and
	 *  the why in one tree */
	why?: string[];
	/** a line row: its code, trimmed — how a compare tells a line an edit above renumbered (the same
	 *  code at another number) from one that changed */
	code?: string;
	children?: DrillNode[];
}

/** `lib/x.ts:42` or `lib/x.ts:42:7` → the file and the line; undefined when `at` names no line */
export function at_line(at: string): { file: string; line: number } | undefined {
	const parts = at.split(':');
	const num = (s: string | undefined) =>
		!!s && s.length > 0 && [...s].every((c) => c >= '0' && c <= '9');
	let n = parts.length;
	// `file:line:col`: the column goes first
	if (n >= 3 && num(parts[n - 1]) && num(parts[n - 2])) n--;
	if (n < 2 || !num(parts[n - 1])) return undefined;
	return { file: parts.slice(0, n - 1).join(':'), line: Number(parts[n - 1]) };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
/** children kept per level; the rest fold into one row */
const KEEP = 6;
/** a child under this share of its parent folds too */
const FOLD_SHARE = 0.02;
/** more rows past KEEP while the fold would hide over this share of the parent */
const KEEP_MAX = 12;
const FOLD_MAX_HIDDEN = 0.1;

/** `GET host/api/product/P12` → `GET host/api/product/:id`: one row per endpoint, not per id */
export function call_group(label: string): string {
	const sp = label.indexOf(' ');
	if (sp === -1) return label;
	const method = label.slice(0, sp);
	const rest = label.slice(sp + 1);
	const q = rest.indexOf('?');
	const path = (q === -1 ? rest : rest.slice(0, q)).split('/');
	for (let i = 1; i < path.length; i++) {
		const s = path[i];
		let digits = 0;
		for (let k = 0; k < s.length; k++) if (s.charCodeAt(k) >= 48 && s.charCodeAt(k) <= 57) digits++;
		// an id: numeric, a uuid-ish run, or a code with digits in it (P12, SKU-01475, P1) — not a word
		// with one digit on it (`step1`, `v2`: a name, a version)
		// (an API version, `v2`, is a word: v1 and v2 are different endpoints)
		const version = s.length >= 2 && s[0] === 'v' && digits === s.length - 1;
		if (
			s &&
			!version &&
			(digits === s.length ||
				(digits >= 2 && digits / s.length >= 0.2) ||
				(digits > 0 && digits / s.length >= 0.5) ||
				s.length >= 24)
		)
			path[i] = ':id';
	}
	return `${method} ${path.join('/')}`;
}

/** a library owner (`render2 (@acme/ui)`) reads as its package; Node's own as `node core` */
function owner_group(s: Segment): string {
	const open = s.label.lastIndexOf(' (');
	if (s.category === 'dependency' && open !== -1 && s.label.endsWith(')'))
		return s.label.slice(open + 2, -1);
	if (s.category === 'node') return 'node core';
	return s.label;
}

/** `GET host/path`: an HTTP call (a timer, a file read or a span has no method word) */
function is_http(label: string): boolean {
	const sp = label.indexOf(' ');
	if (sp < 3 || sp > 7) return false;
	for (let i = 0; i < sp; i++) {
		const c = label.charCodeAt(i);
		if (c < 65 || c > 90) return false;
	}
	return true;
}

/** the first pending resource with the line that queued it: `Immediate from x.ts:52` → `x.ts:52` */
function pending_place(pending: readonly string[] | undefined): string | undefined {
	for (const p of pending ?? []) {
		const at = p.indexOf(' from ');
		if (at !== -1) return p.slice(at + 6);
	}
	return undefined;
}

/** a package row's function: `render2 (@acme/ui)` → `render2`, `node core: writev` → `writev` */
function sub_fn(label: string): string {
	if (label.startsWith('node core: ')) return label.slice('node core: '.length);
	const open = label.lastIndexOf(' (');
	return open !== -1 && label.endsWith(')') ? label.slice(0, open) : label;
}

/** a place in the framework, a package or the server bundle: never "your line" */
function foreign_place(caller: string): boolean {
	return (
		caller.includes('node_modules/') ||
		caller.includes('output/server/') ||
		caller.includes('@sveltejs/') ||
		caller.includes('node:') ||
		caller.includes('.svelte-kit/')
	);
}

/** the line of yours at the top of a call's path — the outermost of your frames before the
 *  framework's (`svc` ← `currentUser` ← `load:70` → `load:70`): where your code asked for it */
function outer_of(caller: string, callers: readonly string[] | undefined): string | undefined {
	if (!callers || callers[0] !== caller) return undefined;
	let top: string | undefined;
	for (let i = 1; i < callers.length && !foreign_place(callers[i]); i++) {
		// a sourcemapped stack drops the framework's frames, so the app's hooks can sit right above
		// the load: the load's own line is the top
		if (callers[i].includes('hooks.server.')) break;
		top = callers[i];
	}
	return top && top !== caller ? top : undefined;
}

function fold(nodes: DrillNode[], parent_ms: number): DrillNode[] {
	nodes.sort((a, b) => b.ms - a.ms);
	const keep: DrillNode[] = [];
	let rest_ms = 0;
	let rest_n = 0;
	// past KEEP, a row still shows while what would fold stays over a tenth of the parent: a fold
	// never hides a big part of a level (up to KEEP_MAX rows)
	let left = nodes.reduce((s, n) => s + n.ms, 0);
	for (const n of nodes) {
		const room =
			keep.length < KEEP || (keep.length < KEEP_MAX && left > parent_ms * FOLD_MAX_HIDDEN);
		if (room && n.ms >= parent_ms * FOLD_SHARE) {
			keep.push(n);
			left -= n.ms;
		} else {
			rest_ms += n.ms;
			rest_n++;
		}
	}
	// the folded rows stay inside the "N more" row: out of the way, never gone (what each was for,
	// the work for nothing, still counts them)
	if (rest_n)
		keep.push({
			label: `${rest_n} more`,
			ms: r2(rest_ms),
			kind: 'more',
			children: nodes.filter((n) => !keep.includes(n))
		});
	return keep;
}

/** `src/lib/ds.ts:17` → its folders and file, and the line */
function split_place(at: string): { parts: string[]; line: string } {
	const colon = at.lastIndexOf(':');
	const file = colon === -1 ? at : at.slice(0, colon);
	return { parts: file.split('/').filter(Boolean), line: colon === -1 ? '' : at.slice(colon + 1) };
}

/** the same file when the shorter path is the tail of the longer one: a report spells one file
 *  `src/lib/…`, `lib/…` or absolute */
function same_file(a: string[], b: string[]): boolean {
	const n = Math.min(a.length, b.length);
	for (let i = 1; i <= n; i++) if (a[a.length - i] !== b[b.length - i]) return false;
	return n > 0;
}

/** Tag every row with the patterns found on its line (a site's own line, or a caller line it names),
 *  and a row with lines under it with theirs too. */
function tag_why(root: DrillNode, patterns: readonly Pick<Pattern, 'kind' | 'sites'>[]): void {
	// by `file name:line`, then the whole path checked on lookup
	const at_line = new Map<string, { parts: string[]; kind: string }[]>();
	const add = (file: string, line: number, kind: string) => {
		const { parts } = split_place(file);
		const k = `${parts[parts.length - 1]}:${line}`;
		(at_line.get(k) ?? at_line.set(k, []).get(k)!).push({ parts, kind });
	};
	for (const p of patterns) {
		for (const s of p.sites) {
			add(s.path || s.file, s.line, p.kind);
			for (const v of s.via ?? []) add(v.path || v.file, v.line, p.kind);
		}
	}
	if (!at_line.size) return;
	const kinds_at = (at: string): string[] => {
		const { parts, line } = split_place(at);
		return (at_line.get(`${parts[parts.length - 1]}:${line}`) ?? [])
			.filter((e) => same_file(e.parts, parts))
			.map((e) => e.kind);
	};
	const walk = (n: DrillNode): Set<string> => {
		const kinds = new Set<string>(n.at && n.kind !== 'lane' ? kinds_at(n.at) : []);
		for (const c of n.children ?? []) for (const k of walk(c)) kinds.add(k);
		if (kinds.size && n.kind !== 'render' && n.kind !== 'phase') n.why = [...kinds];
		return kinds;
	};
	walk(root);
}

/**
 * WHAT A ROW WAS FOR: the page-data keys its lines feed. A wait or a computation whose line (its
 * own, or one of the lines under it) is among a key's source lines in its load (lineage +
 * `key_sources`) fills that key. When every key it fills is read by nothing, the row's whole time
 * bought nothing.
 */
export function tag_fills(
	root: DrillNode,
	keys: readonly {
		key: string;
		from: string | null;
		lines?: number[];
		names?: string[];
		verdict: string;
	}[]
): void {
	const sourced = keys
		.filter((k) => k.from && k.lines?.length)
		.map((k) => ({
			...k,
			parts: split_place(k.from!).parts,
			set: new Set(k.lines),
			named: new Set(k.names ?? [])
		}));
	if (!sourced.length) return;
	const fills_at = (at: string) => {
		const { parts, line } = split_place(at);
		const n = Number(line);
		return sourced.filter((k) => k.set.has(n) && same_file(k.parts, parts));
	};
	const walk = (n: DrillNode, lane?: string[]) => {
		// the lines that speak for this row: a wait's calling lines (and the lines that called those
		// helpers), a CPU row's own place or its lines
		const lines: string[] = [];
		// the most specific line on each path: a helper line shared by every call (`svc`) says nothing
		// about which key one is for; the lines that called it do
		// the lines under a row, the ones an "N more" folded included
		const lines_under = (m: DrillNode): DrillNode[] =>
			(m.children ?? []).flatMap((c) =>
				c.kind === 'line' ? [c] : c.kind === 'more' ? lines_under(c) : []
			);
		const collect = (m: DrillNode) => {
			const under = lines_under(m);
			// a row's own place only when nothing under it says more: a CPU row's `at` is where its
			// function starts, never a key's line — its lines are the ones to read
			if (m.at && (m.kind === 'line' || m.kind === 'cpu') && !under.length) lines.push(m.at);
			for (const c of under) collect(c);
		};
		collect(n);
		if (n.kind === 'wait' || n.kind === 'cpu') {
			const found = new Map<string, boolean>();
			// every line under the row must feed a key for the row to say what it was for: a row whose
			// lines are partly elsewhere (garbage collection over the whole page) is not one key's work
			let unexplained = false;
			for (const at of lines) {
				const ks = fills_at(at);
				if (!ks.length) unexplained = true;
				for (const k of ks) found.set(k.key, (found.get(k.key) ?? false) || k.verdict !== 'unread');
			}
			if (unexplained) found.clear();
			// a helper's CPU in a load file's lane, with no line of the load on its samples: the keys of
			// that load whose lines name the function (`newestReview` only on `freshest`'s lines)
			if (!found.size && n.kind === 'cpu' && lane) {
				for (const k of sourced)
					if (k.named.has(n.label) && same_file(k.parts, lane))
						found.set(k.key, (found.get(k.key) ?? false) || k.verdict !== 'unread');
			}
			if (found.size) n.fills = [...found].map(([key, read]) => ({ key, read }));
		}
		// A LINE ROW speaks for itself: when V8 inlines a helper into the load, its time lands on the
		// load's own line (`const freshest = [...valid].sort(…newestReview…)`), and the owner row
		// above mixes that line with others — the line still says which keys it fills
		if (n.kind === 'line' && n.at && !n.fills) {
			const found = new Map<string, boolean>();
			for (const k of fills_at(n.at))
				found.set(k.key, (found.get(k.key) ?? false) || k.verdict !== 'unread');
			if (found.size) n.fills = [...found].map(([key, read]) => ({ key, read }));
		}
		const here = n.kind === 'lane' && n.at ? split_place(n.at + ':0').parts : lane;
		for (const c of n.children ?? []) walk(c, here);
	};
	walk(root);
}

/** THE WORK FOR NOTHING: the rows of one render whose every key is unread (the topmost such row on
 *  each path, so nothing counts twice), biggest first */
export function unread_rows(
	root: DrillNode | undefined
): { label: string; ms: number; kind: DrillNode['kind']; keys: string[]; at?: string }[] {
	const out: { label: string; ms: number; kind: DrillNode['kind']; keys: string[]; at?: string }[] =
		[];
	const walk = (n: DrillNode) => {
		if (n.fills?.length && n.fills.every((f) => !f.read)) {
			out.push({
				label: n.label,
				ms: n.ms,
				kind: n.kind,
				keys: n.fills.map((f) => f.key),
				...(n.at ? { at: n.at } : {})
			});
			return;
		}
		for (const c of n.children ?? []) walk(c);
	};
	if (root) walk(root);
	return out.sort((a, b) => b.ms - a.ms);
}

/** a garbage maker, as the GC attribution names it: the line it is charged to and its pause time */
export type GcMakerLite = {
	name: string;
	url: string;
	line: number;
	at?: { path: string; line: number };
	gc_ms: number;
};

/** `/abs/app/src/lib/x.ts` → `src/lib/x.ts`, `…/node_modules/pkg/a.js` → `pkg/a.js` */
function short_path(p: string): string {
	const nm = p.lastIndexOf('node_modules/');
	if (nm !== -1) return p.slice(nm + 'node_modules/'.length);
	const src = p.lastIndexOf('/src/');
	return src !== -1 ? p.slice(src + 1) : p;
}

export function build_drill(
	tl: Timeline,
	ledger: readonly LedgerLine[] = [],
	patterns: readonly Pick<Pattern, 'kind' | 'sites'>[] = [],
	gc_makers: readonly GcMakerLite[] = [],
	/** components' render counts in one render (V8's): a component row says how many times it ran */
	renders_of: ReadonlyMap<string, number> = new Map(),
	/** each CPU owner's ms in every profiled render (analyze `owner_runs_ms`) */
	owner_runs: Readonly<Record<string, number[]>> = {},
	/** each CPU owner's ms in the cold first render (ColdStart `owners`) */
	cold_owners: ReadonlyMap<string, number> = new Map(),
	/** each endpoint's waiting in every profiled render (its calls' own clocks, by `call_group`) */
	wait_runs: Readonly<Record<string, number[]>> = {}
): DrillNode | undefined {
	const root = build_tree(tl, ledger, gc_makers);
	if (!root) return root;
	// THE NOISE of a CPU owner row: its low and high over the renders — only for an owner that is one
	// row (its per-run time is its whole time, not split over phases or load files)
	if (Object.keys(owner_runs).length || Object.keys(wait_runs).length) {
		const rows = new Map<string, DrillNode[]>();
		const collect = (n: DrillNode, parent_kind: string) => {
			if (
				(n.kind === 'cpu' || n.kind === 'wait') &&
				(parent_kind === 'phase' || parent_kind === 'lane' || parent_kind === 'more')
			) {
				const k = n.kind + '\0' + n.label;
				(rows.get(k) ?? rows.set(k, []).get(k)!).push(n);
			}
			for (const c of n.children ?? []) collect(c, n.kind);
		};
		collect(root, 'render');
		for (const [k, list] of rows) {
			const label = k.slice(k.indexOf('\0') + 1);
			// a wait row: its endpoint's waiting per render (the calls' own clocks — a network's jitter)
			if (list[0].kind === 'wait') {
				const w = wait_runs[label];
				if (list.length === 1 && w && w.length >= 2)
					list[0].runs = [r2(Math.min(...w)), r2(Math.max(...w))];
				continue;
			}
			const per = owner_runs[label];
			if (list.length !== 1 || !per || per.length < 2) continue;
			list[0].runs = [Math.min(...per), Math.max(...per)];
			// cold, when it stands out: half again its slowest warm render, and 5 ms more
			const cold = cold_owners.get(label);
			if (cold !== undefined && cold >= list[0].runs[1] * 1.5 && cold - list[0].runs[1] >= 5)
				list[0].cold = r2(cold);
		}
	}
	if (patterns.length) tag_why(root, patterns);
	// a component rendered many times: its count on its row, and "renders per item" when that
	// pattern names it (its site is the `{#each}`, not a line of the component)
	const per_item = new Set(
		patterns
			.filter((p) => p.kind === 'render-per-item')
			.flatMap((p) => p.sites.map((s) => s.fn_name ?? ''))
	);
	const walk = (n: DrillNode) => {
		if (n.kind === 'cpu') {
			const count = renders_of.get(n.label);
			if (count && count > 1) n.calls = count;
			if (per_item.has(n.label) && !n.why?.includes('render-per-item'))
				n.why = [...(n.why ?? []), 'render-per-item'];
		}
		for (const c of n.children ?? []) walk(c);
	};
	walk(root);
	return root;
}

function build_tree(
	tl: Timeline,
	ledger: readonly LedgerLine[],
	gc_makers: readonly GcMakerLite[]
): DrillNode | undefined {
	// GARBAGE COLLECTION goes to the lines that made the garbage: each maker's share of the pauses
	// it caused (the GC attribution), grouped by the line of yours it is charged to
	const gc_lines = (() => {
		const by = new Map<string, number>();
		// the heap knows a FUNCTION's start (an arrow at 62), not its line: the ledger's row for that
		// function carries its memory on its hottest line (64), so that is the line to open
		const hot_line = (path: string, line: number): number => {
			const rows = ledger.filter(
				(l) => l.path === path && l.fn && (l.fn.endsWith(`${path}:${line}`) || l.line === line)
			);
			const best = rows.find((l) => l.mem_in_fn) ?? rows.sort((a, b) => b.cpu_ms - a.cpu_ms)[0];
			return best?.line ?? line;
		};
		for (const m of gc_makers) {
			if (m.gc_ms <= 0) continue;
			const at = m.at
				? `${short_path(m.at.path)}:${hot_line(m.at.path, m.at.line)}`
				: m.url
					? `${short_path(m.url)}:${m.line}`
					: m.name;
			by.set(at, (by.get(at) ?? 0) + m.gc_ms);
		}
		const total = [...by.values()].reduce((s, v) => s + v, 0);
		return total > 0 ? [...by].map(([at, ms]) => ({ at, share: ms / total })) : [];
	})();
	const segs = tl.segments.filter((s) => s.t1 > s.t0 && s.category !== 'profiler');
	if (!segs.length) return undefined;
	// phase → group key → { node, and for CPU: the owner's file; for waits: callers }
	type Group = {
		node: DrillNode;
		file?: string;
		callers: Map<string, number>;
		outers?: Map<string, Map<string, number>>;
		fns?: Map<string, { ms: number; file?: string }>;
		lib?: boolean;
		lane?: string;
		split?: NonNullable<DrillNode['split']>;
		split_seen?: Set<string>;
		told_by?: Map<string, number>;
	};
	const phases = new Map<string, Map<string, Group>>();
	// THE LOAD FILE a piece of the load phase belongs to (`routes/+page.server.ts`): a call by the
	// first load file on its call path, CPU by the file its owner sits in. Only the load phase splits
	// by it; elsewhere it is undefined.
	const lane_of = (texts: readonly (string | undefined)[]): string | undefined => {
		for (const t of texts) {
			const l = t ? load_lane_of(t) : null;
			if (l) return l.file;
		}
		return undefined;
	};
	/** A CALL'S OWN CLOCK, once per call (a call spans several segments): until its headers, then its
	 *  body; of the headers wait, what the other side's Server-Timing claims. Their entries often
	 *  nest (`render 30` holding `db 21`), so past the wait itself the largest is their whole. */
	const add_split = (g: Group, c: NonNullable<Segment['calls']>[number]) => {
		if (!is_http(c.label)) return;
		const id = c.label + '\0' + (c.caller ?? '') + '\0' + c.ms;
		if ((g.split_seen ??= new Set()).has(id)) return;
		g.split_seen.add(id);
		const body = Math.min(c.body_ms ?? 0, c.ms);
		const headers = c.ms - body;
		const sp = (g.split ??= { network_ms: 0, body_ms: 0, calls: 0 });
		sp.calls++;
		sp.body_ms += body;
		const t = c.timings?.filter((x) => x.ms > 0) ?? [];
		if (t.length) {
			const sum = t.reduce((s, x) => s + x.ms, 0);
			const largest = Math.max(...t.map((x) => x.ms));
			const theirs = Math.min(headers, sum > headers ? largest : sum);
			sp.theirs_ms = (sp.theirs_ms ?? 0) + theirs;
			sp.told = (sp.told ?? 0) + 1;
			sp.network_ms += headers - theirs;
			for (const x of t)
				(g.told_by ??= new Map()).set(
					x.desc ?? x.name,
					(g.told_by.get(x.desc ?? x.name) ?? 0) + x.ms
				);
		} else sp.network_ms += headers;
	};
	for (const s of segs) {
		const len = s.t1 - s.t0;
		const ph = phases.get(s.phase) ?? phases.set(s.phase, new Map()).get(s.phase)!;
		const in_load = s.phase === 'load';
		if (s.kind === 'wait' && s.calls?.length) {
			// a wait shared by several calls: each holds its even part of the stretch
			const each = len / s.calls.length;
			const keyed = s.calls.map((c) => {
				const lane = in_load ? lane_of([...(c.callers ?? []), c.caller]) : undefined;
				return { c, lane, key: 'w\0' + call_group(c.label) + '\0' + (lane ?? '') };
			});
			// ALONE: nothing else was in flight, so the render waited on this endpoint only — the part a
			// faster answer is sure to save (a shared stretch still waits on the others)
			const alone = keyed.every((k) => k.key === keyed[0].key);
			for (const { c, lane, key } of keyed) {
				const g =
					ph.get(key) ??
					ph
						.set(key, {
							node: { label: call_group(c.label), ms: 0, kind: 'wait', calls: 0, alone: 0 },
							callers: new Map(),
							...(lane ? { lane } : {})
						})
						.get(key)!;
				g.node.ms += each;
				if (alone) g.node.alone! += each;
				add_split(g, c);
				if (c.caller) {
					g.callers.set(c.caller, (g.callers.get(c.caller) ?? 0) + each);
					// the line of yours that called the helper that made the call (`svc` ← `load:60`)
					const outer = outer_of(c.caller, c.callers);
					if (outer) {
						const m =
							(g.outers ??= new Map()).get(c.caller) ??
							g.outers.set(c.caller, new Map()).get(c.caller)!;
						m.set(outer, (m.get(outer) ?? 0) + each);
					}
				}
			}
			continue;
		}
		const label = s.kind === 'cpu' ? owner_group(s) : s.label;
		// a gap names what was pending across it, with the line that queued it (`Immediate from
		// routes/x/+page.server.ts:52`): that line is its place, and its load file its lane
		const file = s.kind === 'gap' ? pending_place(s.pending) : s.file;
		// the load file on its stack (a `$lib` helper a load ran), else the file it sits in
		const lane = in_load ? (s.lane ?? lane_of([file])) : undefined;
		const key = s.kind[0] + '\0' + label + '\0' + (lane ?? '');
		const g =
			ph.get(key) ??
			ph
				.set(key, {
					node: { label, ms: 0, kind: s.kind },
					...(file ? { file } : {}),
					callers: new Map(),
					lib: s.kind === 'cpu' && s.category === 'dependency',
					...(lane ? { lane } : {})
				})
				.get(key)!;
		g.node.ms += len;
		// a package row: which of ITS functions held the time (`getNamedItem`, `computeMode`) — what
		// kind of work the library was doing for you
		if (label !== s.label) {
			const fn = sub_fn(s.label);
			const f =
				(g.fns ??= new Map()).get(fn) ??
				g.fns.set(fn, { ms: 0, ...(s.file ? { file: s.file } : {}) }).get(fn)!;
			f.ms += len;
		}
	}
	// how many calls each wait row stands for: the distinct calls of the render in that group
	// (a call is its label, caller AND own length: sixteen identical `GET /config` from one line are
	// sixteen calls; and per load file, like the rows — one endpoint from two loads is two rows)
	const seen = new Map<string, Set<string>>();
	for (const s of segs)
		for (const c of s.calls ?? []) {
			const lane = s.phase === 'load' ? lane_of([...(c.callers ?? []), c.caller]) : undefined;
			const k = s.phase + '\0' + call_group(c.label) + '\0' + (lane ?? '');
			(seen.get(k) ?? seen.set(k, new Set()).get(k)!).add(
				c.label + '\0' + (c.caller ?? '') + '\0' + c.ms
			);
		}
	// your function's lines: its ledger rows (the ledger holds the whole recording; only the shares
	// are used, applied to this render's time for the function)
	/** the ledger rows of one function. A function's ledger key is `name /abs/path`, an arrow's
	 *  `(anonymous) /abs/path:line`, a component's `C:Name` */
	const rows_of = (f: InnerFn) => {
		const own = split_place(f.file);
		const anon = f.name.startsWith('(');
		return ledger.filter((l) => {
			if (!l.fn || l.cpu_ms <= 0) return false;
			if (l.fn === 'C:' + f.name) return true;
			const sp = anon ? l.fn.indexOf(') ') + 1 : l.fn.lastIndexOf(' ');
			if (sp <= 0 || l.fn.slice(0, sp) !== f.name) return false;
			const def = anon
				? split_place(l.fn.slice(sp + 1))
				: { parts: split_place(l.fn.slice(sp + 1) + ':').parts, line: own.line };
			return def.line === own.line && same_file(def.parts, own.parts);
		});
	};
	/** a function's time as its lines' shares: split by its ledger rows, else its own start line */
	const shares_of = (f: InnerFn, weight: number, into: Map<string, number>) => {
		const rows = rows_of(f);
		const total = rows.reduce((s, l) => s + l.cpu_ms, 0);
		if (total > 0)
			for (const l of rows)
				into.set(
					`${l.file}:${l.line}`,
					(into.get(`${l.file}:${l.line}`) ?? 0) + (weight * l.cpu_ms) / total
				);
		else into.set(f.file, (into.get(f.file) ?? 0) + weight);
	};
	const lines_of = (fn: string) => {
		const into = new Map<string, number>();
		// THE STACK first: what ran inside the owner (its arrows, itself), each by its own lines
		const inner = tl.inner?.[fn];
		const inner_total = inner?.reduce((s, f) => s + f.ms, 0) ?? 0;
		if (inner && inner_total > 0) for (const f of inner) shares_of(f, f.ms / inner_total, into);
		else {
			// no stack record: the ledger rows named after it
			const rows = ledger.filter(
				(l) => l.fn && (l.fn.split(' ')[0] === fn || l.fn === 'C:' + fn) && l.cpu_ms > 0
			);
			const total = rows.reduce((s, l) => s + l.cpu_ms, 0);
			for (const l of rows)
				into.set(`${l.file}:${l.line}`, (into.get(`${l.file}:${l.line}`) ?? 0) + l.cpu_ms / total);
		}
		return [...into].map(([at, share]) => ({ at, share }));
	};
	// a LIBRARY's time roots in YOUR lines that call it (the ledger charges library time to them)
	const callers_of_pkg = (pkg: string) => {
		const rows = ledger
			.map((l) => ({
				l,
				ms: (l.libs ?? []).filter((x) => x.pkg === pkg).reduce((s, x) => s + x.ms, 0)
			}))
			.filter((r) => r.ms > 0);
		const total = rows.reduce((s, r) => s + r.ms, 0);
		return total > 0
			? rows.map((r) => ({ at: `${r.l.file}:${r.l.line}`, share: r.ms / total }))
			: [];
	};
	/** `fetchStock (routes/x.ts:25)` → `routes/x.ts:25`: the place, without the function name */
	const place = (caller: string) => {
		const open = caller.lastIndexOf('(');
		return open !== -1 && caller.endsWith(')') ? caller.slice(open + 1, -1) : caller;
	};
	const phase_nodes: DrillNode[] = [];
	for (const [phase, groups] of phases) {
		const kids: DrillNode[] = [];
		const lane_kids = new Map<string, DrillNode[]>();
		for (const [key, g] of groups) {
			const n = g.node;
			n.ms = r2(n.ms);
			if (n.alone !== undefined) n.alone = r2(n.alone);
			if (n.kind === 'wait') {
				n.calls = seen.get(phase + '\0' + n.label + '\0' + (g.lane ?? ''))?.size ?? 0;
				if (g.split) {
					const sp = g.split;
					// their biggest entries: the first is often a wrapper (`render`), what it holds comes next
					const top = g.told_by
						? [...g.told_by]
								.sort((x, y) => y[1] - x[1])
								.slice(0, 3)
								.map(([name, ms]) => ({ name, ms: r2(ms) }))
						: undefined;
					n.split = {
						calls: sp.calls,
						...(sp.theirs_ms !== undefined ? { theirs_ms: r2(sp.theirs_ms), told: sp.told } : {}),
						network_ms: r2(sp.network_ms),
						body_ms: r2(sp.body_ms),
						...(top?.length ? { top } : {})
					};
				}
				const callers = [...g.callers].map(([caller, ms]): DrillNode => {
					const line: DrillNode = { label: caller, ms: r2(ms), kind: 'line', at: place(caller) };
					const outers = g.outers?.get(caller);
					// only when every call through the line has its outer line: the level must add up
					const covered = outers ? [...outers.values()].reduce((s, v) => s + v, 0) : 0;
					if (outers?.size && covered >= ms * 0.99)
						line.children = fold(
							[...outers].map(([o, oms]) => ({
								label: o,
								ms: r2(oms),
								kind: 'line' as const,
								at: place(o)
							})),
							line.ms
						);
					return line;
				});
				if (callers.length) n.children = fold(callers, n.ms);
			} else if (n.kind === 'cpu') {
				if (g.file) n.at = g.file;
				// your function → its lines; a library → your lines that call it
				const pkg_lines = g.lib ? callers_of_pkg(n.label) : [];
				const gc = n.label === 'garbage collection' ? gc_lines : [];
				const lines = gc.length
					? gc
					: pkg_lines.length
						? pkg_lines
						: key.startsWith('c\0') && !g.lib
							? lines_of(n.label)
							: [];
				if (pkg_lines.length) delete n.at;
				if (lines.length > 1)
					n.children = fold(
						lines.map((l) => ({
							label: l.at,
							ms: r2(n.ms * l.share),
							kind: 'line' as const,
							at: l.at
						})),
						n.ms
					);
				else {
					if (lines.length === 1) n.at = lines[0].at;
					// one line of yours (or none known) calls the package: the level below is the package's
					// own functions, straight from the samples
					if (g.fns && g.fns.size > 1)
						n.children = fold(
							[...g.fns].map(([fn, f]) => ({
								label: fn,
								ms: r2(f.ms),
								kind: 'cpu' as const,
								...(f.file ? { at: f.file } : {})
							})),
							n.ms
						);
				}
			} else if (n.kind === 'gap' && g.file) n.at = g.file;
			if (g.lane) (lane_kids.get(g.lane) ?? lane_kids.set(g.lane, []).get(g.lane)!).push(n);
			else kids.push(n);
		}
		// the load phase, one level per load file: what each load waited on and computed
		for (const [lane, rows] of lane_kids) {
			const ms = r2(rows.reduce((s, k) => s + k.ms, 0));
			kids.push({ label: lane, ms, kind: 'lane', at: lane, children: fold(rows, ms) });
		}
		const ms = r2(kids.reduce((s, k) => s + k.ms, 0));
		phase_nodes.push({
			label: PHASE_LABEL[phase as keyof typeof PHASE_LABEL] ?? phase,
			ms,
			kind: 'phase',
			children: fold(kids, ms)
		});
	}
	const total = r2(phase_nodes.reduce((s, p) => s + p.ms, 0));
	return { label: 'render', ms: total, kind: 'render', children: fold(phase_nodes, total) };
}
