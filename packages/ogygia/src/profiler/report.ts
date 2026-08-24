/**
 * Self-contained HTML rendering for the profiler: the dashboard and the
 * per-profile report. No external assets, no CDN — every page works offline
 * and behind any CSP because we serve it ourselves.
 */

import type { Analysis, FrameCategory, HeapAllocator } from './analyze.js';
import { sequential_ms, type NetCall } from './net.js';
import { io_kind, type IoOp } from './async-io.js';

export interface RequestEntry {
	ts: number;
	method: string;
	path: string;
	route: string | null;
	status: number;
	ms: number;
	/** CPU ms this request burned (process-wide delta; accurate when requests don't overlap) */
	cpu_ms: number;
	/** how many other requests were in flight when this one started */
	inflight: number;
	/** total ms this request spent in outbound network calls */
	net_ms: number;
	net_count: number;
	/** true when the profiler itself made this request (page mode) */
	internal?: boolean;
}

export interface MemSample {
	/** ms offset from window start */
	t: number;
	rss: number;
	heap_used: number;
}

export interface ReportMeta {
	id: string;
	created: number;
	trigger: 'window' | 'page' | 'request';
	/** page mode: the path that was rendered */
	page?: string;
	/** page mode: wall ms of each render run */
	runs?: number[];
	/** request mode: the profiled request */
	request?: { method: string; path: string; route: string | null; ms: number };
	duration_ms: number;
	sample_interval_us: number;
	/** requests that completed inside the recording window */
	requests: RequestEntry[];
	loop_delay?: { p50: number; p99: number; max: number };
	cpu_percent?: number;
	elu_percent?: number;
	rss_mb?: number;
	node: string;
	/** recorded on the dev server (numbers include Vite's module pipeline) */
	dev?: boolean;
}

export interface UserTiming {
	name: string;
	count: number;
	total_ms: number;
	max_ms: number;
}

export interface GcSummary {
	count: number;
	total_ms: number;
	max_ms: number;
}

export interface ReportExtras {
	net: NetCall[];
	heap: HeapAllocator[] | null;
	mem: MemSample[];
	/** performance.measure() spans emitted by the app/libraries during the window */
	measures?: UserTiming[];
	/** precise GC pauses from PerformanceObserver (more exact than the sampler) */
	gc?: GcSummary | null;
	/** I/O primitives timed via async_hooks (timers, fs, dns, sockets) */
	io?: IoOp[];
	/** exact call count per function name, from V8 precise coverage */
	call_counts?: Record<string, number>;
}

export interface RouteAgg {
	route: string;
	count: number;
	p50: number;
	p95: number;
	max: number;
	avg: number;
	net_p50: number;
}

// ---------------------------------------------------------------------------

const esc = (s: unknown): string =>
	String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

const CATEGORY_LABEL: Record<FrameCategory, string> = {
	component: 'component',
	app: 'app code',
	dependency: 'dependency',
	svelte: 'svelte',
	node: 'node core',
	gc: 'GC',
	idle: 'idle',
	v8: 'v8',
	profiler: 'profiler',
	unknown: '—'
};

const CATEGORY_COLOR: Record<FrameCategory, string> = {
	component: '#e8734a',
	app: '#4a9d6e',
	dependency: '#5b8fd6',
	svelte: '#c1544f',
	node: '#8a8f98',
	gc: '#b58a3d',
	idle: '#3a3f47',
	v8: '#6b7280',
	profiler: '#7d6bb0',
	unknown: '#6b7280'
};

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; }
body {
	background: #101318; color: #d8dee6;
	font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
	padding: 24px; max-width: 1150px; margin: 0 auto;
}
h1 { font-size: 20px; margin: 0 0 4px; }
h1 small { color: #7d8590; font-weight: 400; font-size: 13px; margin-left: 8px; }
h2 { font-size: 15px; margin: 32px 0 4px; }
h2 + p.hint { margin: 0 0 10px; }
p.hint { color: #7d8590; font-size: 12.5px; }
a { color: #6cb2ff; text-decoration: none; }
a:hover { text-decoration: underline; }
code { background: #171c24; padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 5px 10px 5px 0; border-bottom: 1px solid #1e232b; vertical-align: top; }
th { color: #7d8590; font-weight: 500; font-size: 12px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.file { color: #7d8590; font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; }
td.fn { font-family: ui-monospace, monospace; font-size: 12.5px; }
.chip { display: inline-block; padding: 0 7px; border-radius: 999px; font-size: 11px; line-height: 18px; color: #0d1014; font-weight: 600; }
.summary { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0; }
.stat { background: #171c24; border: 1px solid #232a35; border-radius: 8px; padding: 10px 14px; min-width: 108px; }
.stat b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
.stat span { color: #7d8590; font-size: 11.5px; }
.verdict { background: #171c24; border-left: 3px solid #e8734a; border-radius: 6px; padding: 12px 16px; margin: 16px 0; font-size: 14px; }
.verdict p + p { margin-top: 6px; }
.bar { height: 14px; border-radius: 3px; min-width: 2px; }
.barrow { display: grid; grid-template-columns: 220px 1fr 90px; gap: 10px; align-items: center; padding: 3px 0; font-size: 13px; }
.barrow .num { text-align: right; font-variant-numeric: tabular-nums; color: #aeb6c2; }
/* wall-clock budget: one stacked bar = the whole window */
.budget { display: flex; height: 34px; border-radius: 7px; overflow: hidden; border: 1px solid #232a35; margin: 6px 0; }
.budget > div { display: flex; align-items: center; justify-content: center; font-size: 10.5px; color: #0d1014; font-weight: 600; overflow: hidden; white-space: nowrap; min-width: 0; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 6px 0 0; font-size: 11.5px; color: #aeb6c2; }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
/* treemap (interactive canvas) */
#tree { width: 100%; height: 440px; border: 1px solid #232a35; border-radius: 8px; background: #0c0f13; display: block; cursor: pointer; }
#tree-crumb a { color: #6cb2ff; }
#tree-tip { position: fixed; pointer-events: none; background: #1c232d; border: 1px solid #2b3340; border-radius: 6px;
	padding: 6px 10px; font-size: 12px; display: none; max-width: 420px; z-index: 10; box-shadow: 0 4px 16px #0008; }
#tree-tip b { font-family: ui-monospace, monospace; }
/* sortable tables + inline self/total bars */
th.sort { cursor: pointer; user-select: none; white-space: nowrap; }
th.sort:hover { color: #d8dee6; }
th.sort.active { color: #6cb2ff; }
th.sort .arr { opacity: 0.5; font-size: 10px; }
td.split { min-width: 160px; }
.split-bar { position: relative; height: 12px; background: #1a212b; border-radius: 3px; overflow: hidden; }
.split-bar .tot { position: absolute; left: 0; top: 0; height: 100%; background: #3a4a5e; border-radius: 3px; }
.split-bar .slf { position: absolute; left: 0; top: 0; height: 100%; border-radius: 3px; }
form.inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0; }
input, select, button {
	background: #171c24; color: #d8dee6; border: 1px solid #2b3340; border-radius: 6px;
	padding: 6px 10px; font: inherit; font-size: 13px;
}
button { cursor: pointer; background: #22303f; }
button:hover { background: #2b3d50; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 14px 0; }
.btn { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 8px;
	border: 1px solid #2b3340; background: #1c2530; color: #d8dee6; cursor: pointer;
	font: inherit; font-size: 13px; text-decoration: none; transition: background .12s, border-color .12s; }
.btn:hover { background: #26313f; border-color: #3a4757; }
.btn.primary { background: #24507e; border-color: #356293; color: #eaf1f8; }
.btn.primary:hover { background: #2b5f96; }
.btn[disabled] { opacity: .6; cursor: default; }
.btn .ic { width: 15px; height: 15px; opacity: .85; }
.btn .sub { color: #8a94a2; font-size: 11px; }
#flame { width: 100%; height: 460px; border: 1px solid #232a35; border-radius: 8px; background: #0c0f13; cursor: pointer; }
#flame-tip { position: fixed; pointer-events: none; background: #1c232d; border: 1px solid #2b3340; border-radius: 6px;
	padding: 6px 10px; font-size: 12px; display: none; max-width: 480px; z-index: 10; box-shadow: 0 4px 16px #0008; }
#flame-tip b { font-family: ui-monospace, monospace; }
.crumb { color: #7d8590; font-size: 12px; margin: 6px 0; min-height: 18px; }
.wf { position: relative; background: #0c0f13; border: 1px solid #232a35; border-radius: 8px; padding: 8px 0; margin: 8px 0; }
.wf-row { position: relative; height: 19px; }
.wf-bar { position: absolute; height: 13px; top: 3px; border-radius: 3px; background: #5b8fd6; min-width: 2px; }
.wf-bar.err { background: #c1544f; }
.wf-bar .body { position: absolute; right: 0; top: 0; height: 100%; background: #3a5d8f; border-radius: 0 3px 3px 0; }
.wf-label { position: absolute; font: 11px ui-monospace, monospace; color: #aeb6c2; top: 2px; white-space: nowrap; }
.spark { display: block; margin: 6px 0; }
.footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #1e232b; color: #7d8590; font-size: 12px; }
.warn { color: #d9a03d; }
`;

function chip(c: FrameCategory): string {
	return `<span class="chip" style="background:${CATEGORY_COLOR[c]}">${CATEGORY_LABEL[c]}</span>`;
}

// the "where" cell: a source path when we have one, else a muted "native"
// (node/v8 builtins carry no url — they live in compiled C++, not a file)
function where(url: string, line: number): string {
	if (!url) return `<span class="hint">native</span>`;
	return `${esc(url)}${line > 0 ? ':' + line : ''}`;
}

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head><body>${body}
<div class="footer">ogygia/profiler — samples the whole Node process during SSR. <b>Self</b> = time (or memory) inside the function itself. <b>Total</b> = self plus everything it called. <b>Per call</b> = total ÷ how many times it ran (a ×N tag means it ran N times; no tag means once).</div>
</body></html>`;
}

const fmt_ms = (n: number): string =>
	n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
const fmt_pct = (part: number, whole: number): string =>
	whole > 0 ? ((part / whole) * 100).toFixed(1) + '%' : '—';
const fmt_bytes = (n: number): string =>
	n >= 1048576
		? (n / 1048576).toFixed(1) + ' MB'
		: n >= 1024
			? (n / 1024).toFixed(0) + ' kB'
			: n + ' B';

// ---------------------------------------------------------------------------
// import / export (.ogp = gzipped profiler dump JSON)

const IC_DOWN =
	'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13m0 0l-4.5-4.5M12 16l4.5-4.5M4 21h16"/></svg>';
const IC_UP =
	'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V8m0 0L7.5 12.5M12 8l4.5 4.5M4 3h16"/></svg>';

/**
 * An Import link → the `/view` page, where you pick a `.ogp` and enter the key it was exported with
 * (ANY .ogp opens in ANY profiler). The key is a field there, not a browser prompt: the profiler is
 * itself behind HTTP Basic Auth, and one request can carry only one `Authorization`, so it can't
 * authenticate the profiler AND carry a different `.ogp` key at once.
 */
function import_button(base: string): string {
	return `<a class="btn" href="${base}/view">${IC_UP}Import<span class="sub">.ogp</span></a>`;
}

/**
 * An Export button whose data is EMBEDDED in the page (not a server URL) — the download works even
 * after the server has evicted this report from memory (only the last few are kept). `ogp_b64` is the
 * already gzipped + AES-GCM-encrypted `.ogp` bytes (base64); clicking just decodes + saves them, so no
 * key ever touches the browser. A trace exposes server internals, so the file can only be reopened by
 * a profiler holding the same key.
 */
function export_button(id: string, ogp_b64: string): string {
	return `<button type="button" class="btn primary" id="og-export">${IC_DOWN}Export<span class="sub">.ogp · encrypted</span></button>
<script type="application/json" id="og-ogp">${JSON.stringify(ogp_b64)}</script>
<script>(function(){
	var b=document.getElementById('og-export');if(!b)return;
	b.addEventListener('click',function(){
		var b64=JSON.parse(document.getElementById('og-ogp').textContent);
		var bin=atob(b64),n=bin.length,arr=new Uint8Array(n);for(var k=0;k<n;k++)arr[k]=bin.charCodeAt(k);
		var blob=new Blob([arr],{type:'application/octet-stream'});
		var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='profile-'+${JSON.stringify(id)}+'.ogp';
		document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(a.href);},1500);
	});
})();</script>`;
}

// ---------------------------------------------------------------------------
// dashboard

export function render_dashboard(opts: {
	base: string;
	recent: RequestEntry[];
	routes: RouteAgg[];
	reports: ReportMeta[];
	recording: boolean;
	dev: boolean;
	rss_mb: number;
	inflight: number;
}): string {
	const { base, recent, routes, reports, recording, rss_mb, inflight, dev } = opts;

	const report_rows = reports
		.map(
			(r) => `<tr>
<td><a href="${base}/report/${r.id}">${esc(label_of(r))}</a></td>
<td>${new Date(r.created).toLocaleTimeString()}</td>
<td class="num">${fmt_ms(r.duration_ms)} ms</td>
<td class="num">${r.requests.length}</td>
</tr>`
		)
		.join('');

	const route_rows = routes
		.slice(0, 20)
		.map(
			(r) => `<tr>
<td class="fn">${esc(r.route)}</td>
<td class="num">${r.count}</td>
<td class="num">${fmt_ms(r.p50)}</td>
<td class="num">${fmt_ms(r.p95)}</td>
<td class="num">${fmt_ms(r.max)}</td>
<td class="num">${fmt_ms(r.net_p50)}</td>
</tr>`
		)
		.join('');

	const recent_rows = recent
		.slice(-40)
		.reverse()
		.map(
			(e) => `<tr>
<td>${new Date(e.ts).toLocaleTimeString()}</td>
<td>${esc(e.method)}</td>
<td class="fn">${esc(e.path)}${e.internal ? ' <span class="warn">(profiler)</span>' : ''}</td>
<td class="file">${esc(e.route ?? '—')}</td>
<td class="num">${e.status || '—'}</td>
<td class="num">${e.net_count ? `${fmt_ms(e.net_ms)} <span class="hint">(${e.net_count})</span>` : '—'}</td>
<td class="num"><b>${fmt_ms(e.ms)}</b></td>
</tr>`
		)
		.join('');

	return page(
		'SSR profiler',
		`<h1>SSR profiler <small>live since server start · ${rss_mb} MB rss · ${inflight} in flight</small></h1>

<div class="actions">${import_button(base)}<span class="sub">open an encrypted <code>.ogp</code> exported from any run</span>${dev ? '' : `<a class="btn" href="${base}/logout" style="margin-left:auto">Lock</a>`}</div>

${recording ? `<p class="verdict">A profile is running right now. Refresh in a moment — or <a href="${base}/reset">reset</a> if a run got stuck.</p>` : ''}

<h2>Profile a page</h2>
<p class="hint">Enter a path on this site. It renders through your real server a few times and shows exactly where the time went — components, functions, allocations, and outbound calls.</p>
<form class="inline" action="${base}/page" method="get">
	<label>path <input name="p" placeholder="/some/slow/page" size="28"></label>
	<label>renders <input name="runs" value="5" size="3"></label>
	<label title="Recommended on serverless (Amplify/Vercel/Netlify): the report can't be kept in memory across invocations, and a huge report can crash the browser. Download the encrypted .ogp, then open it via Import."><input type="checkbox" name="format" value="ogp"> download <code>.ogp</code></label>
	<button>Profile</button>
</form>
<p class="hint">On a <b>serverless</b> host, tick <b>download .ogp</b> — the profile streams back as an encrypted file (the report can't be kept in memory, and a full report can be too heavy for the browser), then <a href="${base}/view">open it here</a>. Or profile one live request with the <code>x-profile: &lt;secret&gt;</code> header.</p>

${reports.length ? `<h2>Reports</h2><table><tr><th>report</th><th>when</th><th class="num">window</th><th class="num">requests</th></tr>${report_rows}</table>` : ''}

<h2>Slowest routes</h2>
<p class="hint">Wall-clock per request since server start. p95 is the slow tail. "net p50" is time inside outbound calls — when it tracks the total, the route is waiting on other services, not computing.</p>
${routes.length ? `<table><tr><th>route</th><th class="num">hits</th><th class="num">p50 ms</th><th class="num">p95 ms</th><th class="num">max ms</th><th class="num">net p50</th></tr>${route_rows}</table>` : '<p class="hint">No requests seen yet — load some pages, then refresh.</p>'}

<h2>Recent requests</h2>
${recent.length ? `<table><tr><th>when</th><th>method</th><th>path</th><th>route</th><th class="num">status</th><th class="num">net ms</th><th class="num">total ms</th></tr>${recent_rows}</table>` : '<p class="hint">Nothing yet.</p>'}`
	);
}

function label_of(r: ReportMeta): string {
	if (r.trigger === 'page') return `page ${r.page} ×${r.runs?.length ?? 0}`;
	if (r.trigger === 'request') return `request ${r.request?.path ?? ''}`;
	return `${Math.round(r.duration_ms / 1000)}s window`;
}

// ---------------------------------------------------------------------------
// bottleneck visuals

interface Leaf {
	name: string;
	cat: FrameCategory;
	value: number;
	url: string;
}
/**
 * The headline "where does the busy CPU actually go" visual: a treemap of SELF
 * time. Every box is real work; the biggest box is the bottleneck. Ancestors
 * (Root/_layout/_page) barely show because their self time is ~0 — exactly what
 * makes this clearer than a total-time list.
 */
function render_treemap(a: Analysis): string {
	const leaves: Leaf[] = a.functions
		.filter((f) => f.self_ms > 0)
		.map((f) => ({ name: f.name, cat: f.category, value: f.self_ms, url: f.url }));
	for (const b of a.buckets) {
		if (b.category === 'gc' && b.self_ms > 0)
			leaves.push({ name: 'garbage collection', cat: 'gc', value: b.self_ms, url: '' });
		if (b.category === 'v8' && b.self_ms > 0)
			leaves.push({ name: 'v8 internals', cat: 'v8', value: b.self_ms, url: '' });
	}
	if (!leaves.length) return '';

	// group by category, cap leaves per group so a long tail becomes one "(other)"
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

	// hierarchy for the client: root → categories → leaves. Layout + zoom happen
	// in the browser (canvas), so a click can drill into any category.
	const busy = a.busy_ms || 1;
	const hierarchy = {
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
	const legend = [...new Set(cat_cells.map((c) => c.cat))]
		.map(
			(c) => `<span><i style="background:${CATEGORY_COLOR[c]}"></i>${esc(CATEGORY_LABEL[c])}</span>`
		)
		.join('');
	return `<div class="crumb" id="tree-crumb"></div>
<canvas id="tree"></canvas>
<div id="tree-tip"></div>
<div class="legend">${legend}</div>
<script type="application/json" id="tree-data">${JSON.stringify(hierarchy).replace(/</g, '\\u003c')}</script>
${TREE_JS}`;
}

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

/** Wall-clock triage bar: is this window CPU-bound or waiting? Segments the whole
 * window into busy buckets + idle, so "mostly idle" (waiting on I/O) vs "mostly
 * your code" is one glance. */
function render_budget_bar(a: Analysis): string {
	const dur = a.duration_ms || 1;
	// buckets already carry an idle entry; drop it and add one canonical idle
	// segment from idle_ms so waiting time is counted exactly once
	const segs = a.buckets
		.filter((b) => b.self_ms > 0 && b.category !== 'idle')
		.map((b) => ({ label: b.key, cat: b.category, ms: b.self_ms }));
	if (a.idle_ms > 0) segs.push({ label: 'idle / waiting', cat: 'idle', ms: a.idle_ms });
	// unaccounted remainder (sampling gaps) so the bar always fills the window
	const acc = segs.reduce((s, x) => s + x.ms, 0);
	if (dur - acc > dur * 0.02) segs.push({ label: 'other', cat: 'unknown', ms: dur - acc });
	segs.sort((x, y) => y.ms - x.ms);
	const cells = segs
		.map((s) => {
			const pct = (s.ms / dur) * 100;
			const label = pct > 8 ? `${s.label} ${pct.toFixed(0)}%` : '';
			return `<div style="width:${pct}%;background:${CATEGORY_COLOR[s.cat]}" title="${esc(s.label)} — ${fmt_ms(s.ms)} ms (${pct.toFixed(1)}%)">${esc(label)}</div>`;
		})
		.join('');
	return `<div class="budget">${cells}</div>`;
}

const TREE_JS = `<script>(function(){
	var canvas=document.getElementById('tree'), tip=document.getElementById('tree-tip'), crumb=document.getElementById('tree-crumb');
	if(!canvas)return;
	var root=JSON.parse(document.getElementById('tree-data').textContent);
	var ctx=canvas.getContext('2d'), dpr=window.devicePixelRatio||1, H=440;
	var stack=[root], rects=[];

	function squarify(items,x,y,w,h){
		var out=[]; var total=0; for(var i=0;i<items.length;i++)total+=items[i].value;
		if(total<=0||w<=0||h<=0)return out;
		var scale=(w*h)/total, rest=items.map(function(it){return {it:it,area:it.value*scale};});
		var rx=x,ry=y,rw=w,rh=h;
		function worst(row,side){var sum=0,mx=0,mn=Infinity;for(var i=0;i<row.length;i++){var a=row[i].area;sum+=a;if(a>mx)mx=a;if(a<mn)mn=a;}var s2=sum*sum;return Math.max(side*side*mx/s2,s2/(side*side*mn));}
		while(rest.length){
			var side=Math.min(rw,rh), row=[], idx=0;
			while(idx<rest.length){ if(row.length===0||worst(row.concat([rest[idx]]),side)<=worst(row,side)){row.push(rest[idx]);idx++;}else break; }
			var rowSum=0;for(var k=0;k<row.length;k++)rowSum+=row[k].area;
			if(rw<=rh){ var sH=rowSum/rw,cx=rx; for(var j=0;j<row.length;j++){var iw=row[j].area/sH; out.push({it:row[j].it,x:cx,y:ry,w:iw,h:sH}); cx+=iw;} ry+=sH; rh-=sH; }
			else { var sW=rowSum/rh,cy=ry; for(var j2=0;j2<row.length;j2++){var ih=row[j2].area/sW; out.push({it:row[j2].it,x:rx,y:cy,w:sW,h:ih}); cy+=ih;} rx+=sW; rw-=sW; }
			rest=rest.slice(row.length);
		}
		return out;
	}

	function box(x,y,w,h,color,alpha){ ctx.globalAlpha=alpha; ctx.fillStyle=color; ctx.fillRect(x,y,Math.max(0,w-1),Math.max(0,h-1)); ctx.globalAlpha=1; }
	function label(x,y,w,txt,sub){ if(w<46)return; ctx.fillStyle='#0d1014'; ctx.font='600 10px ui-monospace,monospace'; ctx.save(); ctx.beginPath(); ctx.rect(x+2,y,w-4,20); ctx.clip(); ctx.fillText(txt,x+4,y+11); if(sub){ctx.font='9px ui-monospace,monospace'; ctx.globalAlpha=0.75; ctx.fillText(sub,x+4,y+21); ctx.globalAlpha=1;} ctx.restore(); }

	function draw(){
		var W=canvas.clientWidth||900; canvas.width=W*dpr; canvas.height=H*dpr; canvas.style.height=H+'px';
		ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);
		rects=[];
		var cur=stack[stack.length-1], atRoot=stack.length===1;
		var cells=squarify(cur.children,0,0,W,H);
		for(var i=0;i<cells.length;i++){
			var c=cells[i], node=c.it;
			if(node.children && atRoot){
				box(c.x,c.y,c.w,c.h,node.color,0.16);
				if(c.w>60&&c.h>22){ ctx.fillStyle=node.color; ctx.font='700 11px ui-monospace,monospace'; ctx.save(); ctx.beginPath(); ctx.rect(c.x+2,c.y,c.w-4,14); ctx.clip(); ctx.fillText(node.label+' · '+node.value+' ms',c.x+4,c.y+11); ctx.restore(); }
				var inner=squarify(node.children,c.x+2,c.y+15,Math.max(0,c.w-4),Math.max(0,c.h-17));
				for(var m=0;m<inner.length;m++){
					var ic=inner[m], leaf=ic.it, op=0.55+Math.min(0.4,(leaf.pct||0)/40);
					box(ic.x,ic.y,ic.w,ic.h,leaf.color,op);
					if(ic.w>46&&ic.h>14) label(ic.x,ic.y,ic.w,leaf.label, ic.h>26?leaf.value+' ms':'');
					rects.push({x:ic.x,y:ic.y,w:ic.w,h:ic.h,node:leaf,zoom:node});
				}
				rects.push({x:c.x,y:c.y,w:c.w,h:15,node:node,zoom:node}); // header band → drill
			} else {
				var op2=0.55+Math.min(0.4,(node.pct||0)/40);
				box(c.x,c.y,c.w,c.h,node.color,op2);
				if(c.w>46&&c.h>16){ ctx.fillStyle='#0d1014'; ctx.font='600 11px ui-monospace,monospace'; ctx.save(); ctx.beginPath(); ctx.rect(c.x+3,c.y,c.w-6,30); ctx.clip(); ctx.fillText(node.label,c.x+4,c.y+13); if(c.h>28){ctx.font='9px ui-monospace,monospace';ctx.globalAlpha=0.8;ctx.fillText(node.value+' ms',c.x+4,c.y+24);ctx.globalAlpha=1;} ctx.restore(); }
				rects.push({x:c.x,y:c.y,w:c.w,h:c.h,node:node,zoom:node.children?node:null});
			}
		}
		crumb.innerHTML = atRoot ? '<span style="color:#7d8590">click a box to zoom in</span>'
			: stack.slice(1).map(function(n){return n.label;}).join(' › ')+' — <a href="#" id="tree-up">zoom out</a>';
		var up=document.getElementById('tree-up'); if(up)up.addEventListener('click',function(e){e.preventDefault();stack.pop();draw();});
	}

	function at(ev){ var r=canvas.getBoundingClientRect(),mx=ev.clientX-r.left,my=ev.clientY-r.top; for(var i=rects.length-1;i>=0;i--){var q=rects[i]; if(mx>=q.x&&mx<=q.x+q.w&&my>=q.y&&my<=q.y+q.h)return q;} return null; }
	canvas.addEventListener('mousemove',function(ev){ var q=at(ev); if(!q||!q.node.label){tip.style.display='none';return;} tip.style.display='block'; tip.style.left=Math.min(ev.clientX+14,window.innerWidth-430)+'px'; tip.style.top=(ev.clientY+14)+'px'; var n=q.node; tip.innerHTML='<b>'+esc(n.label)+'</b>'+(n.sub?'<br><span style="color:#7d8590">'+esc(n.sub)+'</span>':'')+'<br>'+n.value+' ms'+(n.pct!=null?' · '+n.pct+'% of busy':''); });
	canvas.addEventListener('mouseleave',function(){tip.style.display='none';});
	canvas.addEventListener('click',function(ev){ var q=at(ev); if(q&&q.zoom&&q.zoom.children){ stack.push(q.zoom); draw(); } });
	function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');}
	window.addEventListener('resize',draw);
	draw();
})();</script>`;

const TABLE_SORT_JS = `<script>(function(){
	document.querySelectorAll('table[data-sortable]').forEach(function(tbl){
		var tbody=tbl.tBodies[0];
		tbl.querySelectorAll('th.sort').forEach(function(th){
			th.addEventListener('click',function(){
				var key=th.getAttribute('data-key');
				var asc=th.getAttribute('data-dir')!=='asc';
				tbl.querySelectorAll('th.sort').forEach(function(o){o.classList.remove('active');o.removeAttribute('data-dir');var a=o.querySelector('.arr');if(a)a.textContent='';});
				th.classList.add('active'); th.setAttribute('data-dir',asc?'asc':'desc');
				var arr=th.querySelector('.arr'); if(arr)arr.textContent=asc?' ▲':' ▼';
				var rows=[].slice.call(tbody.rows);
				rows.sort(function(a,b){
					var x=parseFloat(a.getAttribute('data-'+key))||0, y=parseFloat(b.getAttribute('data-'+key))||0;
					return asc?x-y:y-x;
				});
				rows.forEach(function(r){tbody.appendChild(r);});
			});
		});
	});
})();</script>`;

// ---------------------------------------------------------------------------
// findings + machine-readable JSON (shared with the HTML verdict)

export interface Finding {
	severity: 'info' | 'warn';
	/** stable machine code, e.g. 'sequential-network' */
	code: string;
	/** one plain-text sentence */
	message: string;
}

/** The plain-language bottleneck read, as structured data. The HTML verdict and
 * the JSON report both render from this, so they never drift. */
export function derive_findings(a: Analysis, meta: ReportMeta, extras: ReportExtras): Finding[] {
	const out: Finding[] = [];
	const info = (code: string, message: string) => out.push({ severity: 'info', code, message });
	const warn = (code: string, message: string) => out.push({ severity: 'warn', code, message });

	const busy_pct = a.duration_ms > 0 ? (a.busy_ms / a.duration_ms) * 100 : 0;
	const net = extras.net.filter((c) => c.ms >= 0);
	const net_total = net.reduce((s, c) => s + c.ms + (c.body_ms ?? 0), 0);
	const seq = sequential_ms(extras.net);
	const net_errors = extras.net.filter((c) => c.error).length;

	info(
		'summary',
		`Over ${fmt_ms(meta.duration_ms)} ms the CPU was busy ${busy_pct.toFixed(0)}%` +
			(net.length
				? ` and ${net.length} outbound network calls took ${fmt_ms(net_total)} ms combined.`
				: '.')
	);

	if (net.length >= 2 && seq > meta.duration_ms * 0.5 && busy_pct < 60) {
		warn(
			'sequential-network',
			`Network calls ran back-to-back for ${fmt_ms(seq)} ms of the window — usually sequential awaits. Batch them with Promise.all.`
		);
	} else if (busy_pct < 25 && meta.trigger !== 'window') {
		info(
			'mostly-waiting',
			net.length
				? 'Mostly waiting on the network, not computing.'
				: 'Mostly waiting, but no HTTP calls were seen. The wait is likely a database/socket client or a timer.'
		);
	}

	const th = top_hosts(net)[0];
	if (th && th.total > meta.duration_ms * 0.2) {
		info(
			'slow-upstream',
			`Slowest upstream: ${th.host || '(unknown)'} — ${th.count} calls, ${fmt_ms(th.total)} ms.`
		);
	}
	if (net_errors)
		warn('network-errors', `${net_errors} network call${net_errors > 1 ? 's' : ''} failed.`);

	const tb = a.buckets.find((b) => b.category !== 'idle' && b.category !== 'profiler');
	if (tb) {
		info(
			'top-cpu',
			`Biggest CPU consumer: ${tb.key} (${fmt_ms(tb.self_ms)} ms, ${fmt_pct(tb.self_ms, a.busy_ms)} of busy time).`
		);
	}
	const tc = a.components[0];
	if (tc)
		info(
			'top-component',
			`Most expensive component: ${tc.name} at ${fmt_ms(tc.total_ms)} ms total.`
		);

	if (a.gc_ms > a.busy_ms * 0.15 && a.gc_ms > 5) {
		warn(
			'gc-heavy',
			`Garbage collection took ${fmt_pct(a.gc_ms, a.busy_ms)} of busy time — see the allocators for who creates the garbage.`
		);
	}
	if (extras.gc && extras.gc.max_ms > 20) {
		warn(
			'gc-pause',
			`Longest single GC pause: ${fmt_ms(extras.gc.max_ms)} ms (${extras.gc.count} pauses, ${fmt_ms(extras.gc.total_ms)} ms total). A long pause freezes every request at once.`
		);
	}
	if (meta.loop_delay && meta.loop_delay.p99 > 50) {
		warn(
			'loop-stall',
			`The event loop stalled up to ${fmt_ms(meta.loop_delay.p99)} ms (p99) — long synchronous work blocks every other request.`
		);
	}
	const mem_delta = extras.mem.length >= 2 ? extras.mem.at(-1)!.rss - extras.mem[0].rss : 0;
	if (mem_delta > 50) warn('mem-growth', `Memory grew ${mem_delta} MB during the window.`);

	const profiler_ms = a.buckets.find((b) => b.key === 'profiler overhead')?.self_ms ?? 0;
	if (profiler_ms > a.busy_ms * 0.05 && profiler_ms > 5) {
		info(
			'profiler-overhead',
			`${fmt_ms(profiler_ms)} ms of busy time is the profiler itself — a one-time cost when recording starts. Your app did not pay this outside the recording.`
		);
	}
	if (meta.dev) {
		info(
			'dev-mode',
			'Recorded on the dev server — Vite module loading and transforms are included. Build and run production for exact figures.'
		);
	}
	return out;
}

/**
 * The whole profile as one curated JSON object — the agent-facing view. Served
 * at `<base>/report/<id>.json`. Not the raw V8 profile (that is `/raw`): this is
 * already analyzed — self/total per component, network attribution, memory, GC,
 * and the same findings the human report shows.
 */
export function report_json(a: Analysis, meta: ReportMeta, base: string, extras: ReportExtras) {
	const dur = a.duration_ms || 1;
	const busy = a.busy_ms || 1;
	const net = extras.net.filter((c) => c.ms >= 0);
	const net_total = round1(net.reduce((s, c) => s + c.ms + (c.body_ms ?? 0), 0));

	const budget = a.buckets
		.filter((b) => b.self_ms > 0 && b.category !== 'idle')
		.map((b) => ({
			label: b.key,
			category: b.category,
			ms: b.self_ms,
			pct: round1((b.self_ms / dur) * 100)
		}));
	if (a.idle_ms > 0)
		budget.push({
			label: 'idle / waiting',
			category: 'idle',
			ms: a.idle_ms,
			pct: round1((a.idle_ms / dur) * 100)
		});
	budget.sort((x, y) => y.ms - x.ms);

	const alloc_by_name = new Map<string, number>();
	for (const h of extras.heap ?? [])
		alloc_by_name.set(h.name, (alloc_by_name.get(h.name) ?? 0) + h.self_bytes);

	const verdict =
		a.idle_ms > dur * 0.5 ? 'waiting' : (a.busy_ms / dur) * 100 > 60 ? 'compute-bound' : 'mixed';
	const hosts = top_hosts(net);

	return {
		schema: 'ogygia-profiler-report',
		version: 1,
		units: { time: 'ms', size: 'bytes', memory_suffix_mb: true },
		id: meta.id,
		created: meta.created,
		kind: meta.trigger,
		node: meta.node,
		dev: !!meta.dev,
		sourcemapped: a.sourcemapped,
		target: { page: meta.page ?? null, runs: meta.runs ?? null, request: meta.request ?? null },
		summary: {
			window_ms: meta.duration_ms,
			busy_ms: a.busy_ms,
			busy_pct: round1((a.busy_ms / dur) * 100),
			idle_ms: a.idle_ms,
			gc_ms: a.gc_ms,
			verdict,
			sample_count: a.sample_count,
			cpu_percent: meta.cpu_percent ?? null,
			elu_percent: meta.elu_percent ?? null,
			loop_delay_ms: meta.loop_delay ?? null,
			rss_mb: meta.rss_mb ?? null
		},
		findings: derive_findings(a, meta, extras),
		budget,
		components: (() => {
			const cc = extras.call_counts ?? {};
			return [...a.components]
				.sort((x, y) => y.self_ms - x.self_ms)
				.map((c) => {
					const n = (cc[c.name] ?? 0) || null;
					return {
						name: c.name,
						instances: n,
						file: c.url,
						line: c.line,
						self_ms: c.self_ms,
						total_ms: c.total_ms,
						// cost of a single render: total ÷ renders (n falls back to 1)
						per_call_ms: round1(c.total_ms / (n ?? 1)),
						pct_busy: round1((c.total_ms / busy) * 100),
						alloc_bytes: alloc_by_name.get(c.name) ?? null
					};
				});
		})(),
		hot_functions: (() => {
			const cc = extras.call_counts ?? {};
			return a.functions.slice(0, 80).map((f) => {
				const n = (cc[f.name] ?? 0) || null;
				return {
					name: f.name,
					instances: n,
					file: f.url,
					line: f.line,
					category: f.category,
					self_ms: f.self_ms,
					total_ms: f.total_ms,
					per_call_ms: round1(f.total_ms / (n ?? 1))
				};
			});
		})(),
		files: a.files
			.filter((f) => f.category !== 'idle')
			.slice(0, 40)
			.map((f) => ({
				file: f.key,
				category: f.category,
				self_ms: f.self_ms,
				pct_busy: round1((f.self_ms / busy) * 100)
			})),
		network: {
			count: net.length,
			total_ms: net_total,
			sequential_ms: sequential_ms(extras.net),
			errors: extras.net.filter((c) => c.error).length,
			hosts: hosts.map((h) => ({
				host: h.host,
				calls: h.count,
				total_ms: h.total,
				p50_ms: h.p50,
				max_ms: h.max,
				errors: h.errors
			})),
			calls: [...net]
				.sort((x, y) => y.ms + (y.body_ms ?? 0) - (x.ms + (x.body_ms ?? 0)))
				.slice(0, 200)
				.map((c) => ({
					method: c.method,
					url: c.url,
					host: c.host,
					status: c.status,
					wait_ms: c.ms,
					body_ms: c.body_ms ?? null,
					bytes: c.bytes ?? null,
					route: c.route ?? c.path ?? null,
					caller: c.caller ?? null,
					error: c.error ?? null
				}))
		},
		memory: {
			rss_start_mb: extras.mem[0]?.rss ?? null,
			rss_end_mb: extras.mem.at(-1)?.rss ?? null,
			growth_mb: extras.mem.length >= 2 ? extras.mem.at(-1)!.rss - extras.mem[0].rss : 0,
			gc: extras.gc ?? null,
			allocators: (extras.heap ?? []).map((h) => ({
				name: h.name,
				file: h.url,
				line: h.line,
				category: h.category,
				self_bytes: h.self_bytes,
				total_bytes: h.total_bytes
			})),
			samples: extras.mem.map((m) => ({ t_ms: m.t, rss_mb: m.rss, heap_used_mb: m.heap_used }))
		},
		waiting: (() => {
			const m = new Map<string, { caller: string; kind: string; count: number; wait_ms: number }>();
			const add = (caller: string, kind: string, ms: number) => {
				const k = caller + '|' + kind;
				const r = m.get(k) ?? { caller, kind, count: 0, wait_ms: 0 };
				r.count++;
				r.wait_ms = round1(r.wait_ms + ms);
				m.set(k, r);
			};
			for (const c of net) if (c.caller) add(c.caller, 'http', c.ms + (c.body_ms ?? 0));
			for (const o of extras.io ?? [])
				if (o.caller && !o.open) add(o.caller, io_kind(o.type), o.ms);
			return [...m.values()].sort((x, y) => y.wait_ms - x.wait_ms).slice(0, 40);
		})(),
		user_timings: (extras.measures ?? []).map((m) => ({
			name: m.name,
			count: m.count,
			total_ms: m.total_ms,
			avg_ms: round1(m.total_ms / m.count),
			max_ms: m.max_ms
		})),
		requests: meta.requests.map((r) => ({
			method: r.method,
			path: r.path,
			route: r.route,
			status: r.status,
			ms: r.ms,
			cpu_ms: r.cpu_ms,
			wait_ms: round1(Math.max(0, r.ms - r.cpu_ms)),
			net_ms: r.net_ms,
			net_count: r.net_count,
			inflight: r.inflight,
			internal: !!r.internal
		})),
		links: {
			html: `${base}/report/${meta.id}`,
			json: `${base}/report/${meta.id}.json`,
			cpuprofile: `${base}/report/${meta.id}/raw`
		}
	};
}

/**
 * A complete, portable dump: everything `render_report` needs to reconstruct the
 * full interactive report later, on any machine. This is the artifact a user
 * downloads from a serverless host (where reports can't be stored) and uploads
 * to the viewer. Rendering needs no inspector, so it works everywhere.
 */
export function report_dump(a: Analysis, meta: ReportMeta, extras: ReportExtras) {
	return { kind: 'ogygia-profiler-dump', version: 1, meta, analysis: a, extras };
}

/** Narrowing guard for an uploaded dump before we render it. */
export function is_dump(
	x: unknown
): x is { meta: ReportMeta; analysis: Analysis; extras: ReportExtras } {
	const d = x as Record<string, unknown> | null;
	return (
		!!d &&
		typeof d === 'object' &&
		d.kind === 'ogygia-profiler-dump' &&
		!!d.meta &&
		!!d.analysis &&
		!!d.extras
	);
}

/** The upload page: pick a downloaded dump file, render it here. */
export function render_upload_page(base: string): string {
	return page(
		'Open a saved profile',
		`<h1>Open a saved profile</h1>
<p class="hint">Recorded on a serverless host (Amplify, Vercel, Netlify) where the report can't be kept in memory? Export the <code>.ogp</code> there, then open it here — it's decrypted and rendered by this profiler. ANY <code>.ogp</code> opens in ANY profiler: enter the key it was exported with (leave blank to use this profiler's own key).</p>
<p><label>key <input type="password" id="k" placeholder="the .ogp's export key — blank = this profiler's" size="44"></label></p>
<p><input type="file" id="f" accept=".ogp,application/octet-stream"></p>
<p class="hint"><a href="${base}">← dashboard</a></p>
<script>
var inp = document.getElementById('f'), kin = document.getElementById('k');
inp.addEventListener('change', async function () {
  var f = inp.files[0]; if (!f) return;
  var buf = await f.arrayBuffer();
  var res = await fetch(location.pathname, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-ogp-key': kin.value }, body: buf
  });
  var html = await res.text();
  document.open(); document.write(html); document.close();
});
</script>`
	);
}

function render_waiting(net: NetCall[], io: IoOp[]): string {
	const rows = new Map<
		string,
		{ caller: string; kind: string; count: number; ms: number; open: number }
	>();
	const add = (caller: string, kind: string, ms: number, open = false) => {
		const key = caller + '|' + kind;
		const r = rows.get(key) ?? { caller, kind, count: 0, ms: 0, open: 0 };
		r.count++;
		r.ms += ms;
		if (open) r.open++;
		rows.set(key, r);
	};
	// only attribute I/O that has a real app caller and actually completed — infra
	// timers (undici keep-alive, the profiler's own sampler) have no owner and their
	// open durations are meaningless
	for (const c of net) if (c.ms >= 0 && c.caller) add(c.caller, 'http', c.ms + (c.body_ms ?? 0));
	for (const o of io) if (o.caller && !o.open) add(o.caller, io_kind(o.type), o.ms);
	const list = [...rows.values()]
		.filter((r) => r.ms >= 0.5)
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 30);
	if (!list.length) return '';
	const max = list[0].ms || 1;
	const body = list
		.map(
			(r) => `<tr data-ms="${r.ms}" data-count="${r.count}">
<td class="fn">${esc(r.caller)}</td>
<td>${esc(r.kind)}</td>
<td class="split"><div class="split-bar" title="${fmt_ms(r.ms)} ms across ${r.count} call${r.count > 1 ? 's' : ''}"><div class="slf" style="width:${((r.ms / max) * 100).toFixed(1)}%;background:${kind_color(r.kind)}"></div></div></td>
<td class="num">${r.count}${r.open ? ` <span class="warn">(${r.open} open)</span>` : ''}</td>
<td class="num"><b>${fmt_ms(r.ms)}</b></td>
</tr>`
		)
		.join('');
	return `<h2>Waiting by function <span class="hint" style="font-weight:400">(click a column to sort)</span></h2>
<p class="hint">Where the server WAITED (not computed), attributed to the function that started the I/O — timed from the async primitive (a fetch, a timer, a file read, a database socket), so it catches waits the CPU profiler and the HTTP table both miss. A big number here with idle CPU is your bottleneck. "socket" times can be inflated by connection keep-alive; trust the HTTP table for exact per-call figures.</p>
<table data-sortable><thead><tr><th>function</th><th>kind</th><th>wait</th><th class="num sort" data-key="count">count<span class="arr"></span></th><th class="num sort active" data-key="ms" data-dir="desc">wait ms<span class="arr"> ▼</span></th></tr></thead><tbody>${body}</tbody></table>`;
}

/** Bar color per I/O kind, for the Waiting-by-function bars. */
function kind_color(kind: string): string {
	switch (kind) {
		case 'http':
			return '#5b8fd6';
		case 'timer':
			return '#b58a3d';
		case 'file':
			return '#4a9d6e';
		case 'socket':
			return '#c1544f';
		case 'dns':
			return '#7d6bb0';
		default:
			return '#8a8f98';
	}
}

// ---------------------------------------------------------------------------
// report

export function render_report(
	a: Analysis,
	meta: ReportMeta,
	base: string,
	extras: ReportExtras,
	ogp_b64?: string
): string {
	const busy_pct = a.duration_ms > 0 ? (a.busy_ms / a.duration_ms) * 100 : 0;
	const net = extras.net.filter((c) => c.ms >= 0);
	const net_total = net.reduce((s, c) => s + c.ms + (c.body_ms ?? 0), 0);

	// ---- findings (one source, shared with the .json report) --------------
	const v = derive_findings(a, meta, extras).map((f) =>
		f.severity === 'warn' ? `<span class="warn">${esc(f.message)}</span>` : esc(f.message)
	);

	// ---- summary stats ----------------------------------------------------
	const stats: string[] = [
		stat(fmt_ms(meta.duration_ms) + ' ms', 'window'),
		stat(busy_pct.toFixed(0) + '%', 'CPU busy'),
		stat(net.length ? fmt_ms(net_total) + ' ms' : '0', `network (${net.length} calls)`),
		stat(fmt_ms(a.gc_ms) + ' ms', 'garbage collection'),
		stat(String(meta.requests.length), 'requests in window')
	];
	if (extras.gc)
		stats.push(stat(fmt_ms(extras.gc.max_ms) + ' ms', `GC pause max (${extras.gc.count})`));
	if (meta.loop_delay) stats.push(stat(fmt_ms(meta.loop_delay.p99) + ' ms', 'loop delay p99'));
	if (meta.elu_percent !== undefined)
		stats.push(stat(meta.elu_percent.toFixed(0) + '%', 'event loop use'));
	if (meta.rss_mb !== undefined) stats.push(stat(meta.rss_mb + ' MB', 'memory (rss)'));
	stats.push(stat(String(a.sample_count), 'samples'));

	// ---- page/request context --------------------------------------------
	let runs_html = '';
	if (meta.trigger === 'page' && meta.runs?.length) {
		const sorted = [...meta.runs].sort((x, y) => x - y);
		const med = sorted[Math.floor(sorted.length / 2)];
		runs_html = `<h2>Renders of ${esc(meta.page ?? '')}</h2>
<p class="hint">Each run is one full server render, median ${fmt_ms(med)} ms. The first run may include one-time module loading.</p>
<p class="fn">${meta.runs.map((r) => fmt_ms(r) + ' ms').join(' · ')}</p>`;
	}
	if (meta.trigger === 'request' && meta.request) {
		runs_html = `<h2>Profiled request</h2>
<p class="fn">${esc(meta.request.method)} ${esc(meta.request.path)} — ${fmt_ms(meta.request.ms)} ms (route ${esc(meta.request.route ?? '—')})</p>`;
	}

	// ---- component memory join --------------------------------------------
	const alloc_by_name = new Map<string, number>();
	for (const h of extras.heap ?? []) {
		alloc_by_name.set(h.name, (alloc_by_name.get(h.name) ?? 0) + h.self_bytes);
	}
	const has_alloc = alloc_by_name.size > 0;

	// how many times each component rendered — a component's cost is often
	// repetition (×800), not one heavy render. Per render in page mode.
	const counts = extras.call_counts ?? {};
	const has_counts = Object.keys(counts).length > 0;
	const instances = (name: string): number => counts[name] ?? 0;

	// default order: self desc, so real CPU burners rise and structural
	// ancestors (Root/_layout/_page, self ≈ 0) sink to the bottom
	const comp_max_total = Math.max(...a.components.map((c) => c.total_ms), 1);
	const comp_rows = [...a.components]
		.sort((x, y) => y.self_ms - x.self_ms)
		.map((f) => {
			const alloc = alloc_by_name.get(f.name);
			const totW = (f.total_ms / comp_max_total) * 100;
			const slfW = (f.self_ms / comp_max_total) * 100;
			const n = instances(f.name);
			// per-call = total ÷ renders. n falls back to 1 (no tag ⇒ rendered once).
			const per = f.total_ms / (n > 0 ? n : 1);
			const tag =
				n > 1
					? ` <span class="hint" title="${n} renders, ${fmt_ms(f.total_ms / n)} ms each (total ÷ ${n})">×${n}</span>`
					: '';
			return `<tr data-self="${f.self_ms}" data-total="${f.total_ms}" data-per="${per}" data-name="${esc(f.name)}" data-count="${n}">
<td class="fn"><b>${esc(f.name)}</b>${tag}</td>
<td class="file">${where(f.url, f.line)}</td>
<td class="split"><div class="split-bar" title="self ${fmt_ms(f.self_ms)} ms of total ${fmt_ms(f.total_ms)} ms"><div class="tot" style="width:${totW.toFixed(1)}%"></div><div class="slf" style="width:${slfW.toFixed(1)}%;background:${CATEGORY_COLOR[f.category]}"></div></div></td>
<td class="num"><b>${fmt_ms(f.self_ms)}</b></td>
<td class="num">${fmt_ms(f.total_ms)}</td>
<td class="num" title="total ÷ ${n > 0 ? n : 1} render${n === 1 || n === 0 ? '' : 's'}">${fmt_ms(per)}</td>
<td class="num">${fmt_pct(f.total_ms, a.busy_ms)}</td>
${has_alloc ? `<td class="num">${alloc ? fmt_bytes(alloc) : '—'}</td>` : ''}
</tr>`;
		})
		.join('');

	const fn_rows = a.functions
		.slice(0, 80)
		.map((f) => {
			const alloc = alloc_by_name.get(f.name);
			const n = instances(f.name);
			const per = f.total_ms / (n > 0 ? n : 1);
			const tag =
				n > 1
					? ` <span class="hint" title="${n} calls, ${fmt_ms(f.total_ms / n)} ms each (total ÷ ${n})">×${n}</span>`
					: '';
			return `<tr data-self="${f.self_ms}" data-total="${f.total_ms}" data-per="${per}" data-alloc="${alloc ?? 0}" data-count="${n}">
<td class="fn"><b>${esc(f.name)}</b>${tag}</td>
<td class="file">${where(f.url, f.line)}</td>
<td>${chip(f.category)}</td>
<td class="num"><b>${fmt_ms(f.self_ms)}</b></td>
<td class="num">${fmt_ms(f.total_ms)}</td>
<td class="num" title="total ÷ ${n > 0 ? n : 1} call${n === 1 || n === 0 ? '' : 's'}">${fmt_ms(per)}</td>
${has_alloc ? `<td class="num">${alloc ? fmt_bytes(alloc) : '—'}</td>` : ''}
</tr>`;
		})
		.join('');

	const file_rows = a.files
		.filter((f) => f.category !== 'idle')
		.slice(0, 25)
		.map(
			(f) => `<tr><td class="file">${esc(f.key)}</td><td>${chip(f.category)}</td>
<td class="num"><b>${fmt_ms(f.self_ms)}</b></td><td class="num">${fmt_pct(f.self_ms, a.busy_ms)}</td></tr>`
		)
		.join('');

	const max_bucket = Math.max(...a.buckets.map((b) => b.self_ms), 1);
	const bucket_rows = a.buckets
		.filter((b) => b.category !== 'idle')
		.slice(0, 15)
		.map(
			(b) => `<div class="barrow"><span class="fn">${esc(b.key)}</span>
<div class="bar" style="width:${Math.max(1, (b.self_ms / max_bucket) * 100)}%;background:${CATEGORY_COLOR[b.category]}"></div>
<span class="num">${fmt_ms(b.self_ms)} ms</span></div>`
		)
		.join('');

	// ---- network ----------------------------------------------------------
	const hosts = top_hosts(net);
	const host_rows = hosts
		.slice(0, 12)
		.map(
			(
				h
			) => `<tr><td class="fn">${esc(h.host || '(same process)')}</td><td class="num">${h.count}</td>
<td class="num"><b>${fmt_ms(h.total)}</b></td><td class="num">${fmt_ms(h.p50)}</td><td class="num">${fmt_ms(h.max)}</td>
<td class="num">${h.errors || '—'}</td></tr>`
		)
		.join('');

	const net_rows = [...net]
		.sort((x, y) => y.ms + (y.body_ms ?? 0) - (x.ms + (x.body_ms ?? 0)))
		.slice(0, 60)
		.map(
			(c) => `<tr>
<td>${esc(c.method)}</td>
<td class="file" title="${esc(c.url)}">${esc(short_url(c.url))}</td>
<td class="num">${c.error ? `<span class="warn">ERR</span>` : c.status || '—'}</td>
<td class="num"><b>${fmt_ms(c.ms)}</b></td>
<td class="num">${c.body_ms !== undefined ? fmt_ms(c.body_ms) : '—'}</td>
<td class="num">${c.bytes !== undefined ? fmt_bytes(c.bytes) : '—'}</td>
<td class="file">${esc(c.route ?? c.path ?? '—')}</td>
<td class="fn">${esc(c.caller ?? '—')}</td>
</tr>`
		)
		.join('');

	const waterfall = render_waterfall(net);

	// ---- user timings (performance.measure) -------------------------------
	const measures = extras.measures ?? [];
	const measure_rows = measures
		.map(
			(m) => `<tr><td class="fn">${esc(m.name)}</td><td class="num">${m.count}</td>
<td class="num"><b>${fmt_ms(m.total_ms)}</b></td><td class="num">${fmt_ms(m.total_ms / m.count)}</td><td class="num">${fmt_ms(m.max_ms)}</td></tr>`
		)
		.join('');

	// ---- memory -----------------------------------------------------------
	const spark = render_spark(extras.mem);
	const heap_rows = (extras.heap ?? [])
		.map(
			(h) => `<tr>
<td class="fn"><b>${esc(h.name)}</b></td>
<td class="file">${esc(h.url)}${h.line > 0 ? ':' + h.line : ''}</td>
<td>${chip(h.category)}</td>
<td class="num"><b>${fmt_bytes(h.self_bytes)}</b></td>
<td class="num">${fmt_bytes(h.total_bytes)}</td>
</tr>`
		)
		.join('');

	const req_rows = meta.requests
		.slice(0, 60)
		.map(
			(
				e
			) => `<tr><td>${esc(e.method)}</td><td class="fn">${esc(e.path)}${e.internal ? ' <span class="warn">(profiler)</span>' : ''}</td>
<td class="file">${esc(e.route ?? '—')}</td><td class="num">${e.status || '—'}</td><td class="num">${e.inflight}</td>
<td class="num">${e.net_count ? fmt_ms(e.net_ms) : '—'}</td><td class="num">${fmt_ms(e.cpu_ms)}</td><td class="num">${fmt_ms(Math.max(0, e.ms - e.cpu_ms))}</td><td class="num"><b>${fmt_ms(e.ms)}</b></td></tr>`
		)
		.join('');

	return page(
		`SSR profile — ${label_of(meta)}`,
		`<h1>SSR profile <small>${esc(label_of(meta))} · ${new Date(meta.created).toLocaleString()} · node ${esc(meta.node)}${a.sourcemapped ? ' · sourcemapped' : ''}</small></h1>
<div class="actions">${ogp_b64 ? export_button(meta.id, ogp_b64) : ''}${import_button(base)}</div>
<p class="hint"><a href="${base}">← dashboard</a> · <a href="${base}/report/${meta.id}.json">JSON</a> (agents) · <a href="${base}/report/${meta.id}/raw">.cpuprofile</a> (DevTools / speedscope) · Export is an encrypted <code>.ogp</code> — re-open it with Import (needs this profiler's key)</p>

<div class="summary">${stats.join('')}</div>

<h2>Where the time went</h2>
<p class="hint">The whole window, wall-clock. If the biggest segment is "idle / waiting", the server was blocked on I/O, not computing — look at Network below. If it's "your code", the treemap and Components table show exactly where.</p>
${render_budget_bar(a)}

<h2>CPU by self time</h2>
<p class="hint">Every box is real work; the biggest box is the bottleneck. This is <b>self</b> time, so parents like Root/_layout barely show — only code that actually burns CPU. Hover for detail.</p>
${busy_pct < 25 ? `<p class="hint" style="color:#d9a03d">This window barely used the CPU (${busy_pct.toFixed(0)}% busy) — the bottleneck is <b>waiting</b>, not computing. Look at "Waiting by function" below; the treemap here is just the small slice of real CPU work (mostly node\u2019s I/O machinery).</p>` : ''}
${render_treemap(a)}

<div class="verdict">${v.join(' ')}</div>
${runs_html}

${
	net.length
		? `<h2>Network</h2>
<p class="hint">Every outbound call the server made during the window, tied to the route that made it. "wait" = until headers arrived; "body" = reading the response.${meta.trigger === 'page' && (meta.runs?.length ?? 0) > 1 ? ` Shown for one representative render (of ${meta.runs!.length}) — the same page rendered ${meta.runs!.length}× makes the same calls, so the waterfall isn't multiplied.` : ''}</p>
${waterfall}
<table><tr><th>host</th><th class="num">calls</th><th class="num">total ms</th><th class="num">p50</th><th class="num">max</th><th class="num">errors</th></tr>${host_rows}</table>
<br>
<table><tr><th>method</th><th>url</th><th class="num">status</th><th class="num">wait ms</th><th class="num">body ms</th><th class="num">size</th><th>from route</th><th>caller</th></tr>${net_rows}</table>`
		: `<h2>Network</h2><p class="hint">No outbound HTTP calls seen in this window. If requests are still slow while the CPU is idle, the wait is inside a database/socket driver or a timer.</p>`
}

${render_waiting(net, extras.io ?? [])}

<h2>Components <span class="hint" style="font-weight:400">(${a.components.length}, click a column to sort)</span></h2>
<p class="hint"><b>self</b> = time in the component’s own code (its script + its own HTML), excluding nested components. <b>total</b> = self plus every component and function it calls. Ancestors like Root/_layout/_page have tiny self but huge total because they contain the whole page — <b>sort by self</b> to find who burns CPU, <b>by total</b> for the most expensive subtree. The bright bar is self inside the dim total.${has_counts ? ' <b>\u00d7N</b> next to a name is how many times it rendered per page (its cost is repetition, not one slow render).' : ''}${has_alloc ? ' "alloc" is memory allocated by the component’s own code.' : ''}</p>
${comp_rows ? `<table data-sortable><thead><tr><th>component</th><th>file</th><th>self / total</th><th class="num sort active" data-key="self" data-dir="desc">self ms<span class="arr"> ▼</span></th><th class="num sort" data-key="total">total ms<span class="arr"></span></th><th class="num sort" data-key="per" title="total ÷ renders — the cost of a single render">per call<span class="arr"></span></th><th class="num">% of busy</th>${has_alloc ? '<th class="num sort" data-key="alloc">alloc<span class="arr"></span></th>' : ''}</tr></thead><tbody>${comp_rows}</tbody></table>` : '<p class="hint">No component frames in this recording — was any page rendered during the window?</p>'}

<h2>Hot functions <span class="hint" style="font-weight:400">(click a column to sort)</span></h2>
<p class="hint">Every function on the server, by time spent inside it. This is where the CPU actually went.${has_counts ? ' <b>×N</b> is the exact call count (from V8 coverage), so you can see if a function is slow itself or just called a lot.' : ''}</p>
<table data-sortable><thead><tr><th>function</th><th>where</th><th></th><th class="num sort active" data-key="self" data-dir="desc">self ms<span class="arr"> ▼</span></th><th class="num sort" data-key="total">total ms<span class="arr"></span></th><th class="num sort" data-key="per" title="total ÷ calls — the cost of a single call">per call<span class="arr"></span></th>${has_alloc ? '<th class="num sort" data-key="alloc">alloc<span class="arr"></span></th>' : ''}</tr></thead><tbody>${fn_rows}</tbody></table>

${
	heap_rows
		? `<h2>Top memory allocators</h2>
<p class="hint">Sampled heap allocations during the window — who creates the objects (and therefore the GC pressure).</p>
<table><tr><th>function</th><th>where</th><th></th><th class="num">self</th><th class="num">total</th></tr>${heap_rows}</table>`
		: ''
}

${spark ? `<h2>Memory over the window</h2>${spark}` : ''}

${
	measure_rows
		? `<h2>User timings</h2>
<p class="hint">Spans your app or its libraries emitted with performance.measure() — captured for free during the window (database drivers, OpenTelemetry, SvelteKit tracing). Real wall time, including waiting.</p>
<table><tr><th>name</th><th class="num">count</th><th class="num">total ms</th><th class="num">avg ms</th><th class="num">max ms</th></tr>${measure_rows}</table>`
		: ''
}

<h2>Time by file</h2>
${file_rows ? `<table><tr><th>file</th><th></th><th class="num">self ms</th><th class="num">% of busy</th></tr>${file_rows}</table>` : ''}

<h2>Where the CPU went</h2>
${bucket_rows}

<h2>Requests during the window</h2>
<p class="hint">Wall-clock time. High total with low net and low CPU = waiting on something we can't see (database driver, semaphore). "inflight" = other requests sharing the CPU at the same time.</p>
${req_rows ? `<table><tr><th>method</th><th>path</th><th>route</th><th class="num">status</th><th class="num">inflight</th><th class="num">net ms</th><th class="num">cpu ms</th><th class="num">wait ms</th><th class="num">total ms</th></tr>${req_rows}</table>` : '<p class="hint">No requests completed inside the window.</p>'}

<h2>Flame graph</h2>
<p class="hint">Width = time. Click a bar to zoom, click it again to zoom back out. Orange bars are your components.</p>
<div class="crumb" id="crumb"></div>
<canvas id="flame"></canvas>
<div id="flame-tip"></div>
<script type="application/json" id="flame-data">${JSON.stringify(a.flame).replace(/</g, '\\u003c')}</script>
<script>${FLAME_JS}</script>
${TABLE_SORT_JS}`
	);
}

function stat(value: string, label: string): string {
	return `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
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

function short_url(url: string): string {
	try {
		const u = new URL(url);
		const path = u.pathname.length > 48 ? u.pathname.slice(0, 45) + '…' : u.pathname;
		return u.host + path + (u.search ? '?…' : '');
	} catch {
		return url.length > 64 ? url.slice(0, 61) + '…' : url;
	}
}

function top_hosts(
	net: NetCall[]
): { host: string; count: number; total: number; p50: number; max: number; errors: number }[] {
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

/** timeline of network calls, offset from window start */
function render_waterfall(net: NetCall[]): string {
	if (net.length < 2 || net.length > 120) return '';
	const sorted = [...net].sort((a, b) => a.epoch - b.epoch);
	// Span from the first call to the last call's end — NOT the whole profiling window (which
	// includes CPU-only time, and in page mode the other identical renders). This fills the width
	// with the one render's calls instead of bunching them into a slice.
	const t0 = sorted[0].epoch;
	const last_end = sorted.reduce((m, c) => Math.max(m, c.epoch + c.ms + (c.body_ms ?? 0)), 0);
	const span = Math.max(last_end - t0, 1);
	const rows = sorted
		.map((c) => {
			const left = Math.max(0, ((c.epoch - t0) / span) * 100);
			const dur = c.ms + (c.body_ms ?? 0);
			const width = Math.min(100 - left, Math.max((dur / span) * 100, 0.3));
			const body_pct = dur > 0 && c.body_ms ? (c.body_ms / dur) * 100 : 0;
			const label = `${c.method} ${wf_url(c.url)} — ${fmt_ms(dur)} ms`;
			// label sits just right of the bar; if the bar is in the right third, put it to
			// the left (right-anchored) so it never runs off the edge or overlaps
			const style =
				left + width > 62
					? `right:calc(${(100 - left).toFixed(1)}% + 6px)`
					: `left:calc(${(left + width).toFixed(1)}% + 6px)`;
			return `<div class="wf-row">
<div class="wf-bar${c.error ? ' err' : ''}" style="left:${left}%;width:${width}%" title="${esc(c.url)}">${body_pct > 5 ? `<span class="body" style="width:${body_pct}%"></span>` : ''}</div>
<span class="wf-label" style="${style}">${esc(label)}</span>
</div>`;
		})
		.join('');
	return `<div class="wf">${rows}</div>`;
}

/** inline SVG sparkline of rss over the window */
function render_spark(mem: MemSample[]): string {
	if (mem.length < 3) return '';
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
	return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<polyline points="${pts}" fill="none" stroke="#5b8fd6" stroke-width="1.5"/>
<text x="${pad}" y="12" fill="#7d8590" font-size="11">${max} MB</text>
<text x="${pad}" y="${h - 6}" fill="#7d8590" font-size="11">${min} MB</text>
</svg>
<p class="hint">rss ${mem[0].rss} → ${mem.at(-1)!.rss} MB · heap ${mem[0].heap_used} → ${mem.at(-1)!.heap_used} MB</p>`;
}

// ---------------------------------------------------------------------------
// flamegraph (inline, dependency-free)

const FLAME_JS = `
(function () {
	var COLORS = ${JSON.stringify(CATEGORY_COLOR)};
	var root = JSON.parse(document.getElementById('flame-data').textContent);
	var canvas = document.getElementById('flame');
	var tip = document.getElementById('flame-tip');
	var crumb = document.getElementById('crumb');
	var ctx = canvas.getContext('2d');
	var ROW = 20, dpr = window.devicePixelRatio || 1;
	var zoom = root, stack = [];
	var rects = [];

	function depth(n) {
		var d = 1, ch = n.ch || [];
		for (var i = 0; i < ch.length; i++) d = Math.max(d, 1 + depth(ch[i]));
		return d;
	}

	function layout() {
		var w = canvas.clientWidth;
		var h = Math.min(600, Math.max(260, depth(zoom) * ROW + 10));
		canvas.style.height = h + 'px';
		canvas.width = w * dpr; canvas.height = h * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);
		rects = [];
		draw(zoom, 0, 0, w);
	}

	function draw(node, d, x, w) {
		if (w < 0.5) return;
		var y = d * ROW;
		ctx.fillStyle = COLORS[node.c] || '#6b7280';
		ctx.beginPath();
		if (ctx.roundRect) ctx.roundRect(x + 0.5, y + 1, Math.max(w - 1, 1), ROW - 2, 2);
		else ctx.rect(x + 0.5, y + 1, Math.max(w - 1, 1), ROW - 2);
		ctx.fill();
		if (w > 30) {
			ctx.fillStyle = '#0d1014';
			ctx.font = '11px ui-monospace, monospace';
			var label = node.n + ' (' + node.t.toFixed(1) + 'ms)';
			ctx.save();
			ctx.beginPath(); ctx.rect(x + 4, y, w - 8, ROW); ctx.clip();
			ctx.fillText(label, x + 5, y + 14);
			ctx.restore();
		}
		rects.push({ x: x, y: y, w: w, h: ROW, node: node });
		var ch = node.ch || [];
		var cx = x;
		var scale = node.t > 0 ? w / node.t : 0;
		for (var i = 0; i < ch.length; i++) {
			var cw = ch[i].t * scale;
			draw(ch[i], d + 1, cx, cw);
			cx += cw;
		}
	}

	function hit(ev) {
		var r = canvas.getBoundingClientRect();
		var mx = ev.clientX - r.left, my = ev.clientY - r.top;
		for (var i = rects.length - 1; i >= 0; i--) {
			var q = rects[i];
			if (mx >= q.x && mx <= q.x + q.w && my >= q.y && my <= q.y + q.h) return q;
		}
		return null;
	}

	canvas.addEventListener('mousemove', function (ev) {
		var q = hit(ev);
		if (!q) { tip.style.display = 'none'; return; }
		tip.style.display = 'block';
		tip.style.left = Math.min(ev.clientX + 14, window.innerWidth - 360) + 'px';
		tip.style.top = (ev.clientY + 14) + 'px';
		tip.innerHTML = '<b>' + escapeHtml(q.node.n) + '</b><br>total ' + q.node.t.toFixed(2)
			+ ' ms · self ' + q.node.s.toFixed(2) + ' ms'
			+ (q.node.f ? '<br><span style="color:#7d8590">' + escapeHtml(q.node.f) + '</span>' : '');
	});
	canvas.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
	canvas.addEventListener('click', function (ev) {
		var q = hit(ev);
		if (!q) return;
		if (q.node === zoom) {
			zoom = stack.pop() || root;
		} else {
			stack.push(zoom);
			zoom = q.node;
		}
		crumb.textContent = zoom === root ? '' : 'zoomed: ' + zoom.n + ' — click the top bar to go back';
		layout();
	});
	window.addEventListener('resize', layout);

	function escapeHtml(s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
	}

	layout();
})();
`;

export function render_message(title: string, msg: string, base: string): string {
	return page(
		title,
		`<h1>${esc(title)}</h1><p>${esc(msg)}</p><p><a href="${base}">← dashboard</a></p>`
	);
}

/**
 * The unlock page — a single password field that POSTs the key to `${base}/login`, which validates it
 * and sets a session cookie. Replaces HTTP Basic Auth: one styled field, a real session (survives
 * navigation, cleared by Logout), and the `Authorization` header stays free. `next` is where to return
 * after unlocking. Renders 200 so it's a normal page, not a browser auth dialog.
 */
export function render_login(base: string, next: string): string {
	return page(
		'ogygia profiler — locked',
		`<h1>ogygia profiler <small>locked</small></h1>
<p class="hint">Enter the profiler key to continue. It's kept for this browser session.</p>
<p class="verdict" id="og-login-err" style="display:none">Wrong key.</p>
<form class="inline" id="og-login">
	<label>key <input type="password" id="og-login-key" autofocus size="34" autocomplete="current-password"></label>
	<button class="btn primary">Unlock</button>
</form>
<script>(function(){
	var f=document.getElementById('og-login'),k=document.getElementById('og-login-key'),e=document.getElementById('og-login-err');
	var next=${JSON.stringify(next)};
	// fetch + JSON (not a form POST) so Kit's CSRF — which only guards form content-types and would
	// otherwise need the app's ORIGIN set — never applies. The session cookie rides the response.
	f.addEventListener('submit',async function(ev){
		ev.preventDefault();e.style.display='none';
		try{
			var r=await fetch(${JSON.stringify(base + '/login')},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k.value,next:next})});
			if(r.ok){var d=await r.json();location.href=d.next||${JSON.stringify(base)};return;}
		}catch(x){}
		e.style.display='';k.value='';k.focus();
	});
})();</script>`
	);
}
