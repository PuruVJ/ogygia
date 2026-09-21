/**
 * Pure data prep for the Report component — the aggregations report.ts used to bake straight into
 * HTML (treemap hierarchy, budget segments, waiting-by-function rows, host rollup, waterfall bars,
 * memory sparkline). Kept out of the .svelte file so it stays plain, testable logic; the component
 * just renders what these return. Findings/sequential/io-kind are reused from their existing homes.
 */
import type { Analysis, FrameCategory, GroupStat } from '../analyze.js';
import type { NetCall, UpstreamTrace } from '../net.js';
import type { IoOp } from '../async-io.js';
import type { ClientIslandStat, MemSample, ReportExtras, ReportMeta, RequestEntry } from '../report.js';
import { group_islands, hole_economics, island_js_bytes, island_name, island_rows_of } from '../report.js';
import type { HoleStat, IslandStat, SeedKeyStat } from '../../server/request-stats.js';
import { io_kind } from '../async-io.js';
import { CATEGORY_LABEL, CATEGORY_COLOR, fmt_bytes } from './format.js';

// ── the ogygia side of a page: islands, the seed, the holes ─────────────────────────────────

export interface IslandRow {
	name: string;
	entry: string;
	fp: string;
	/** distinct fingerprints merged into this row (different props per copy) */
	variants: number;
	copies: number;
	wake: string;
	/** the component's SSR time per render (joined from the components table by name), or null */
	ssr_ms: number | null;
	props_bytes: number;
	canonical_bytes: number;
	json: boolean;
	culprit: string | null;
	refs: number;
	ref_keys: string[];
	/** unique bytes of module + preload hints (null when unweighed: dev, or an unreachable asset) */
	js_bytes: number | null;
	/** each module with its bytes, heaviest first, and what the build packed into it */
	modules: { url: string; bytes: number | null; inside: string[] | null }[];
	interactivity: IslandStat['interactivity'];
	/** the sum of every interactivity marker; -1 when the build did not scan it */
	marks: number;
	client: ClientIslandStat | null;
	/** what to do about this island, when the numbers say something */
	advice: string | null;
	// sort keys (the sortable helper reads numbers)
	client_ms: number;
	js_sort: number;
}

/** One row per island fingerprint, joined with the server (components), the build (weights,
 *  interactivity) and the browser (beacon). */
export function island_rows(a: Analysis, meta: ReportMeta, extras: ReportExtras): IslandRow[] {
	const runs = meta.trigger === 'page' ? Math.max(meta.runs?.length ?? 1, 1) : 1;
	const by_name = new Map(a.components.map((c) => [c.name, c]));
	const client = new Map((extras.client ?? []).map((c) => [c.entry, c]));
	const beacon_seen = client.size > 0;
	return group_islands(island_rows_of(meta)).map((r) => {
		const name = island_name(r);
		const comp = by_name.get(name);
		const cl = client.get(r.entry) ?? null;
		const modules = [...new Set([r.module_url, ...r.hints].filter(Boolean))]
			.map((url) => ({ url, bytes: extras.weights?.[url] ?? null, inside: extras.contents?.[url] ?? null }))
			.sort((x, y) => (y.bytes ?? -1) - (x.bytes ?? -1));
		const js_bytes = island_js_bytes(r, extras.weights);
		const i = r.interactivity;
		const marks = i ? i.handlers + i.state + i.effects + i.binds + i.actions : -1;
		let advice: string | null = null;
		if (beacon_seen && !cl && (r.wake === 'load' || r.wake === 'idle' || r.wake === 'visible'))
			advice = `Never reported hydrating in your visits while other islands did. A '${r.wake}' island that ${r.wake === 'visible' ? 'never intersects the viewport (can the page scroll? is it hidden?)' : 'throws on wake (the browser console has it)'} never wakes.`;
		else if (cl && cl.recovered > 0)
			advice =
				`${cl.recovered} of ${cl.n} hydrations threw the server DOM away and re-rendered: the markup the browser found was not what the server sent (a post-SSR pass, a script that edits it before the wake). It paid for the render twice and flashed.` +
				(cl.reason ? ` Why: ${cl.reason}.` : '');
		else if (marks === 0 && r.wake !== 'none') advice = "No handlers, state, effects, binds or actions in its components: ship it as a lake (wake: 'none') and the JS never loads.";
		else if (r.count >= 10 && (r.wake === 'load' || r.wake === 'idle' || r.wake === 'visible'))
			advice = `${r.count} copies each wake on ${r.wake}${(r.variants ?? 1) > 1 ? ` with ${r.variants} different props sidecars` : ''}: one island around the list hydrates once, or wake: 'interaction' pays only when touched.`;
		else if (!r.json && r.culprit) advice = `Its props use devalue because of ${r.culprit}: a string or number there puts them on the JSON lane.`;
		else if (js_bytes !== null && js_bytes >= 150 * 1024) advice = `${fmt_bytes(js_bytes)} of JS for one island: the heaviest module below is the import to move server-side or behind a dynamic import.`;
		else if (cl && cl.load_p50_ms >= cl.p50_ms * 0.6 && cl.p50_ms >= 50) advice = `In the browser most of its ${cl.p50_ms.toFixed(0)} ms is module load: an earlier preload or a smaller closure helps more than faster code.`;
		return {
			name,
			entry: r.entry,
			fp: r.fp,
			variants: r.variants ?? 1,
			copies: r.count,
			wake: r.wake,
			ssr_ms: comp ? comp.total_ms / runs : null,
			props_bytes: r.props_bytes,
			canonical_bytes: r.canonical_bytes,
			json: r.json,
			culprit: r.culprit,
			refs: r.refs,
			ref_keys: r.ref_keys,
			js_bytes,
			modules,
			interactivity: i,
			marks,
			client: cl,
			advice,
			client_ms: cl?.p50_ms ?? 0,
			js_sort: js_bytes ?? 0
		};
	});
}

export interface SeedRow extends SeedKeyStat {
	readers_names: string[];
	referenced_names: string[];
	pct: number;
}

/** The seed explainer's rows: every top-level page.data key, biggest first, with why it ships. */
export function seed_rows(meta: ReportMeta): { rows: SeedRow[]; whole_by: string[]; total: number } | null {
	const og = meta.requests.find((r) => r.og?.seed)?.og;
	if (!og?.seed) return null;
	const total = og.seed.keys.reduce((s, k) => s + k.bytes, 0) || 1;
	return {
		// the explainer names islands already (hooks.ts explain_seed)
		rows: og.seed.keys.map((k) => ({
			...k,
			readers_names: k.readers,
			referenced_names: k.referenced_by,
			pct: (k.bytes / total) * 100
		})),
		whole_by: og.seed.whole_by,
		total
	};
}

export interface HoleRow extends HoleStat {
	hit: number;
	miss: number;
	none: number;
	requests: number;
	avg_ms: number | null;
	verdict: string;
}

/** The holes the page rendered, with what their endpoint did during the window. */
export function hole_rows(meta: ReportMeta): HoleRow[] {
	const og = meta.requests.find((r) => r.og?.hole_rows?.length)?.og;
	const econ = hole_economics(meta);
	return (og?.hole_rows ?? []).map((h) => {
		const e = econ.get(h.id);
		const requests = e ? e.hit + e.miss + e.none : 0;
		const verdict =
			h.ttl > 0 && requests >= 2 && e!.hit === 0
				? 'maxAge set, cache never hit'
				: h.ttl > 0 && e && e.hit > 0
					? `${Math.round((e.hit / requests) * 100)}% from cache`
					: h.ttl > 0
						? 'cached (no requests in the window)'
						: 'renders fresh on every visit';
		return {
			...h,
			hit: e?.hit ?? 0,
			miss: e?.miss ?? 0,
			none: e?.none ?? 0,
			requests,
			avg_ms: e && requests ? e.ms / requests : null,
			verdict
		};
	});
}

/** The size to show for a call: the DECODED body when we measured it (robust — a cloned-stream count),
 *  else the wire size from content-length, else undefined. */
export function net_size(c: NetCall): number | undefined {
	return c.bytes ?? c.transfer_bytes;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface TreeNode {
	label: string;
	value: number;
	color: string;
	pct?: number;
	sub?: string;
	children?: TreeNode[];
}

/** Root → category → leaf hierarchy of self-time, capped per group (long tail → one "(N more)"). */
export function build_treemap(a: Analysis): TreeNode | null {
	interface Leaf {
		name: string;
		cat: FrameCategory;
		value: number;
		url: string;
	}
	const leaves: Leaf[] = a.functions
		.filter((f) => f.self_ms > 0)
		.map((f) => ({ name: f.name, cat: f.category, value: f.self_ms, url: f.url }));
	for (const b of a.buckets) {
		if (b.category === 'gc' && b.self_ms > 0)
			leaves.push({ name: 'garbage collection', cat: 'gc', value: b.self_ms, url: '' });
		if (b.category === 'v8' && b.self_ms > 0)
			leaves.push({ name: 'v8 internals', cat: 'v8', value: b.self_ms, url: '' });
	}
	if (!leaves.length) return null;

	const groups = new Map<FrameCategory, Leaf[]>();
	for (const l of leaves) {
		const g = groups.get(l.cat) ?? [];
		g.push(l);
		groups.set(l.cat, g);
	}
	const cat_cells: { cat: FrameCategory; value: number; leaves: Leaf[] }[] = [];
	for (const [cat, list] of groups) {
		list.sort((x, y) => y.value - x.value);
		const keep = list.slice(0, 16);
		const tail = list.slice(16);
		if (tail.length) {
			const sum = tail.reduce((s, i) => s + i.value, 0);
			keep.push({ name: `(${tail.length} more)`, cat, value: sum, url: '' });
		}
		cat_cells.push({ cat, value: list.reduce((s, i) => s + i.value, 0), leaves: keep });
	}
	cat_cells.sort((x, y) => y.value - x.value);

	const busy = a.busy_ms || 1;
	return {
		label: 'all',
		value: cat_cells.reduce((s, c) => s + c.value, 0),
		color: '#6b7280',
		children: cat_cells.map((c) => ({
			label: CATEGORY_LABEL[c.cat],
			value: round1(c.value),
			color: CATEGORY_COLOR[c.cat],
			pct: round1((c.value / busy) * 100),
			children: c.leaves.map((l) => ({
				label: l.name,
				sub: l.url,
				value: round1(l.value),
				color: CATEGORY_COLOR[c.cat],
				pct: round1((l.value / busy) * 100)
			}))
		}))
	};
}

/** Distinct categories present in the treemap, for the legend. */
export function treemap_legend(a: Analysis): FrameCategory[] {
	const cats = new Set<FrameCategory>();
	for (const f of a.functions) if (f.self_ms > 0) cats.add(f.category);
	for (const b of a.buckets)
		if ((b.category === 'gc' || b.category === 'v8') && b.self_ms > 0) cats.add(b.category);
	return [...cats];
}

export interface BudgetSeg {
	label: string;
	cat: FrameCategory;
	ms: number;
	pct: number;
}

/** The wall-clock triage bar: busy buckets + one canonical idle segment + an "other" remainder. */
export function budget_segments(a: Analysis): BudgetSeg[] {
	const dur = a.duration_ms || 1;
	const segs = a.buckets
		.filter((b) => b.self_ms > 0 && b.category !== 'idle')
		.map((b) => ({ label: b.key, cat: b.category, ms: b.self_ms }));
	if (a.idle_ms > 0)
		segs.push({ label: 'idle / waiting', cat: 'idle' as FrameCategory, ms: a.idle_ms });
	const acc = segs.reduce((s, x) => s + x.ms, 0);
	if (dur - acc > dur * 0.02)
		segs.push({ label: 'other', cat: 'unknown' as FrameCategory, ms: dur - acc });
	segs.sort((x, y) => y.ms - x.ms);
	return segs.map((s) => ({ ...s, pct: (s.ms / dur) * 100 }));
}

export interface WaitRow {
	caller: string;
	kind: string;
	count: number;
	ms: number;
	open: number;
}

/** Where the server WAITED, attributed to the function that started the I/O (net + async-hooks). */
export function waiting_rows(net: NetCall[], io: IoOp[]): WaitRow[] {
	const rows = new Map<string, WaitRow>();
	const add = (caller: string, kind: string, ms: number, open = false) => {
		const key = caller + '|' + kind;
		const r = rows.get(key) ?? { caller, kind, count: 0, ms: 0, open: 0 };
		r.count++;
		r.ms += ms;
		if (open) r.open++;
		rows.set(key, r);
	};
	for (const c of net) if (c.ms >= 0 && c.caller) add(c.caller, 'http', c.ms + (c.body_ms ?? 0));
	for (const o of io) if (o.caller && !o.open) add(o.caller, io_kind(o.type), o.ms);
	return [...rows.values()]
		.filter((r) => r.ms >= 0.5)
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 30);
}

export interface HostRow {
	host: string;
	count: number;
	total: number;
	p50: number;
	max: number;
	errors: number;
}

export function top_hosts(net: NetCall[]): HostRow[] {
	const by_host = new Map<string, number[]>();
	const errors = new Map<string, number>();
	for (const c of net) {
		const t = c.ms + (c.body_ms ?? 0);
		let list = by_host.get(c.host);
		if (!list) by_host.set(c.host, (list = []));
		list.push(t);
		if (c.error) errors.set(c.host, (errors.get(c.host) ?? 0) + 1);
	}
	return [...by_host.entries()]
		.map(([host, list]) => {
			const sorted = [...list].sort((a, b) => a - b);
			return {
				host,
				count: list.length,
				total: Math.round(list.reduce((a, c) => a + c, 0) * 100) / 100,
				p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
				max: sorted.at(-1) ?? 0,
				errors: errors.get(host) ?? 0
			};
		})
		.sort((a, b) => b.total - a.total);
}

export function short_url(url: string): string {
	try {
		const u = new URL(url);
		const path = u.pathname.length > 48 ? u.pathname.slice(0, 45) + '…' : u.pathname;
		return u.host + path + (u.search ? '?…' : '');
	} catch {
		return url.length > 64 ? url.slice(0, 61) + '…' : url;
	}
}

function wf_url(url: string): string {
	try {
		const u = new URL(url);
		const s = u.pathname + u.search;
		return s.length > 44 ? s.slice(0, 43) + '…' : s;
	} catch {
		return url.length > 44 ? url.slice(0, 43) + '…' : url;
	}
}

/** The request detail a waterfall bar opens in the side panel (a serializable slice of NetCall). */
export interface WfCall {
	method: string;
	url: string;
	status: number;
	ms: number;
	body_ms?: number;
	bytes?: number;
	transfer_bytes?: number;
	encoding?: string;
	type?: string;
	req_bytes?: number;
	req_payload?: string;
	route: string | null;
	path: string | null;
	/** the first-party call path above the caller, nearest first */
	callers?: string[];
	/** the upstream's own Server-Timing entries */
	timings?: { name: string; ms: number; desc?: string }[];
	/** the upstream profiler's own picture of this request (nested trace) */
	trace?: UpstreamTrace;
	caller?: string;
	headers?: Record<string, string>;
	error?: string;
}

export interface WfRow {
	left: number;
	width: number;
	bodyPct: number;
	err: boolean;
	label: string;
	title: string;
	rightAnchored: boolean;
	/** Compact size shown INSIDE the bar (decoded, else transfer). Empty when unknown. */
	sizeLabel: string;
	/** Everything the side panel shows when the bar is clicked. */
	call: WfCall;
}

/** Network waterfall bars, spanned from the first call to the last call's end. */
export function waterfall_rows(net: NetCall[]): WfRow[] {
	if (net.length < 2 || net.length > 120) return [];
	const sorted = [...net].sort((a, b) => a.epoch - b.epoch);
	const t0 = sorted[0].epoch;
	const last_end = sorted.reduce((m, c) => Math.max(m, c.epoch + c.ms + (c.body_ms ?? 0)), 0);
	const span = Math.max(last_end - t0, 1);
	return sorted.map((c) => {
		const left = Math.max(0, ((c.epoch - t0) / span) * 100);
		const dur = c.ms + (c.body_ms ?? 0);
		const width = Math.min(100 - left, Math.max((dur / span) * 100, 0.3));
		const sz = net_size(c);
		return {
			left,
			width,
			bodyPct: dur > 0 && c.body_ms ? (c.body_ms / dur) * 100 : 0,
			err: !!c.error,
			title: c.url,
			label: `${c.method} ${wf_url(c.url)} — ${dur >= 100 ? dur.toFixed(0) : dur >= 10 ? dur.toFixed(1) : dur.toFixed(2)} ms`,
			rightAnchored: left + width > 62,
			sizeLabel: sz != null ? fmt_bytes(sz) : '',
			call: {
				method: c.method,
				url: c.url,
				status: c.status,
				ms: c.ms,
				body_ms: c.body_ms,
				bytes: c.bytes,
				transfer_bytes: c.transfer_bytes,
				encoding: c.encoding,
				type: c.type,
				req_bytes: c.req_bytes,
				req_payload: c.req_payload,
				route: c.route,
				path: c.path,
				caller: c.caller,
				callers: c.callers,
				timings: c.timings,
				trace: c.trace,
				headers: c.headers,
				error: c.error
			}
		};
	});
}

export interface RequestRow {
	method: string;
	path: string;
	route: string | null;
	status: number;
	internal: boolean;
	tags: string;
	/** how many identical requests the window saw (page mode: one per run) */
	count: number;
	inflight: number;
	net_count: number;
	net_ms: number;
	cpu_ms: number;
	wait_ms: number;
	ms: number;
	max_ms: number;
}

const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

/**
 * The "requests during the window" rows. Page mode renders the same page N times, so the log
 * holds N copies of the page request and N copies of every call it makes: fold identical
 * requests (method, path, route, status, tags) into one row with the count and the MEDIAN of each
 * number, biggest first. A window recording keeps every request as it happened.
 */
export function request_rows(requests: RequestEntry[], fold: boolean): RequestRow[] {
	const tags_of = (e: RequestEntry) =>
		e.tags ? Object.entries(e.tags).map(([k, v]) => `${k}=${v}`).join(' ') : '';
	if (!fold) {
		return requests.map((e) => ({
			method: e.method,
			path: e.path,
			route: e.route,
			status: e.status,
			internal: !!e.internal,
			tags: tags_of(e),
			count: 1,
			inflight: e.inflight,
			net_count: e.net_count,
			net_ms: e.net_ms,
			cpu_ms: e.cpu_ms,
			wait_ms: Math.max(0, e.ms - e.cpu_ms),
			ms: e.ms,
			max_ms: e.ms
		}));
	}
	const groups = new Map<string, RequestEntry[]>();
	for (const e of requests) {
		const key = [e.method, e.path, e.route ?? '', e.status, tags_of(e)].join('\0');
		const g = groups.get(key);
		if (g) g.push(e);
		else groups.set(key, [e]);
	}
	return [...groups.values()]
		.map((list) => {
			const e = list[0];
			return {
				method: e.method,
				path: e.path,
				route: e.route,
				status: e.status,
				internal: list.some((x) => x.internal),
				tags: tags_of(e),
				count: list.length,
				inflight: med(list.map((x) => x.inflight)),
				net_count: med(list.map((x) => x.net_count)),
				net_ms: med(list.map((x) => x.net_ms)),
				cpu_ms: med(list.map((x) => x.cpu_ms)),
				wait_ms: med(list.map((x) => Math.max(0, x.ms - x.cpu_ms))),
				ms: med(list.map((x) => x.ms)),
				max_ms: Math.max(...list.map((x) => x.ms))
			};
		})
		.sort((a, b) => b.ms - a.ms);
}

export interface Spark {
	pts: string;
	min: number;
	max: number;
	w: number;
	h: number;
	pad: number;
	first: MemSample;
	last: MemSample;
}

/** Sparkline geometry for rss over the window. */
export function spark(mem: MemSample[]): Spark | null {
	if (mem.length < 3) return null;
	const w = 640,
		h = 64,
		pad = 4;
	const t_max = Math.max(mem.at(-1)!.t, 1);
	const values = mem.map((m) => m.rss);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = Math.max(max - min, 1);
	const pts = mem
		.map(
			(m) =>
				`${pad + (m.t / t_max) * (w - 2 * pad)},${h - pad - ((m.rss - min) / range) * (h - 2 * pad)}`
		)
		.join(' ');
	return { pts, min, max, w, h, pad, first: mem[0], last: mem.at(-1)! };
}

export type { GroupStat };
