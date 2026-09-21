<script lang="ts">
	/**
	 * The full SSR profile report. Static sections render server-side; the interactive widgets are
	 * `wake:'load'` islands (treemap, flame graph, sortable tables, export button). Ports report.ts's
	 * render_report — no HTML strings, no minified script blobs.
	 *
	 * THE ORDER IS THE POINT: what to fix first (the findings, the paths, the one render explained),
	 * then the stories that need reading (memory, the data, the islands and the browser, the
	 * network), then the raw tables everything above is an aggregate of. Nothing is left out; the
	 * raw numbers come last.
	 */
	import { derive_findings, span_rows, cold_rows, page_score_of } from '../report.js';
	import { fmt_ms, fmt_pct, fmt_bytes, label_of, CATEGORY_COLOR, CATEGORY_LABEL } from './format.js';
	import {
		build_treemap,
		treemap_legend,
		budget_segments,
		waiting_rows,
		top_hosts,
		waterfall_rows,
		request_rows,
		island_rows,
		seed_rows,
		hole_rows,
		spark as build_spark
	} from './report-data.js';
	import IslandsTable from './IslandsTable.svelte' with { wake: 'load' };
	import Paths from './Paths.svelte' with { wake: 'load' };
	import Awaits from './Awaits.svelte' with { wake: 'load' };
	import SeedExplainer from './SeedExplainer.svelte' with { wake: 'load' };
	import Shell from './Shell.svelte';
	import ExportButton from './ExportButton.svelte' with { wake: 'load' };
	import ScoreCard from './ScoreCard.svelte';
	import Treemap from './Treemap.svelte' with { wake: 'load' };
	import Flame from './Flame.svelte' with { wake: 'load' };
	import ComponentsTable from './ComponentsTable.svelte' with { wake: 'load' };
	import FunctionsTable from './FunctionsTable.svelte' with { wake: 'load' };
	import WaitingTable from './WaitingTable.svelte' with { wake: 'load' };
	import Waterfall from './Waterfall.svelte' with { wake: 'load' };

	import ShareLink from './ShareLink.svelte' with { wake: 'load' };
	import Timeline from './Timeline.svelte' with { wake: 'load' };
	import Scrub from './Scrub.svelte' with { wake: 'load' };
	import RenderSteps from './RenderSteps.svelte' with { wake: 'load' };
	import AllocStrip from './AllocStrip.svelte';
	import OnThisPage from './OnThisPage.svelte' with { wake: 'load' };
	import OneClock from './OneClock.svelte' with { wake: 'load' };
	import ByteStrip from './ByteStrip.svelte' with { wake: 'load' };
	import DataRiver from './DataRiver.svelte' with { wake: 'load' };
	import IslandHeatmap from './IslandHeatmap.svelte' with { wake: 'load' };
	import DomTravel from './DomTravel.svelte' with { wake: 'load' };
	import KeepLocal from './KeepLocal.svelte' with { wake: 'load' };
	import { island_rows_of, island_name } from '../report.js';
	import { PHASE_LABEL } from '../timeline.js';
	import { sync_io, memo_candidates, span_values } from '../insights.js';
	import { render_steps } from '../steps.js';
	import { row_href } from './row-anchor.svelte.js';
	import type { Analysis } from '../analyze.js';
	import type { ReportMeta, ReportExtras } from '../report.js';
	import type { PageHistory } from '../profiler-router.js';
	// The report renderer, fed the fields directly — from the server (a logged-in `/report/[id]`) OR
	// from a decrypted share-link `#fragment` (PermalinkGate). One body, two sources.
	let {
		a,
		meta,
		base,
		extras,
		ogpB64,
		history = null,
		prev = null,
		dev = false
	}: {
		a: Analysis;
		meta: ReportMeta;
		base: string;
		extras: ReportExtras;
		ogpB64?: string;
		history?: PageHistory | null;
		prev?: string | null;
		dev?: boolean;
	} = $props();
	const fmt_kb = (b: number) => `${Math.round(b / 1024)} KB`;
	// The ogygia page score — derived here from the same meta+extras the findings read, so the card
	// and the findings never disagree (report.ts serializes the same value for agents).
	const score = page_score_of(meta, extras);
	// ogygia's own cost on the profiled page: the request with the largest side-channels
	const og =
		[...meta.requests]
			.filter((r) => r.og)
			.sort((x, y) => y.og!.seed_bytes + y.og!.tail_bytes - (x.og!.seed_bytes + x.og!.tail_bytes))[0]?.og ??
		null;
	// history: this page's medians over time (page mode), newest last
	const hist = history && history.points.length >= 2 ? history.points : null;
	const hist_geom = hist
		? (() => {
				const w = 320,
					h = 48,
					pad = 4;
				const max = Math.max(...hist.map((p) => p.median), 1);
				const step = hist.length > 1 ? (w - 2 * pad) / (hist.length - 1) : 0;
				const pts = hist.map((p, i) => [pad + i * step, h - pad - (p.median / max) * (h - 2 * pad)] as const);
				return { w, h, max, pts, poly: pts.map(([x, y]) => `${x},${y}`).join(' ') };
			})()
		: null;
	const hist_prev = hist ? hist[hist.length - 2] : null;
	const hist_last = hist ? hist[hist.length - 1] : null;
	const hist_delta = hist_prev && hist_last && hist_prev.median > 0 ? ((hist_last.median - hist_prev.median) / hist_prev.median) * 100 : 0;

	const busy_pct = a.duration_ms > 0 ? (a.busy_ms / a.duration_ms) * 100 : 0;
	const net = extras.net.filter((c) => c.ms >= 0);
	const net_total = net.reduce((s, c) => s + c.ms + (c.body_ms ?? 0), 0);
	const findings = derive_findings(a, meta, extras);
	// group the findings by the area they touch, so "what to fix" reads as a few labelled clusters,
	// not one wall — warnings float to the top of each cluster
	const FCAT_ORDER = ['Network', 'CPU', 'Memory', 'Data & seed', 'Islands & delivery', 'Overview'];
	const fcat = (code: string) => {
		const has = (...ks: string[]) => ks.some((k) => code.includes(k));
		if (has('await', 'network', 'n-plus', 'upstream', 'self-fetch', 'sequential')) return 'Network';
		if (has('gc', 'alloc', 'mem', 'retain', 'promise')) return 'Memory';
		if (has('seed', 'key-', 'props', 'river', 'data')) return 'Data & seed';
		if (has('island', 'wake', 'hole', 'cold')) return 'Islands & delivery';
		if (has('cpu', 'path', 'component', 'deopt', 'memo', 'span', 'loop', 'sync', 'value')) return 'CPU';
		return 'Overview';
	};
	const finding_groups = FCAT_ORDER.map((label) => ({
		label,
		items: findings
			.filter((f) => fcat(f.code) === label)
			.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'warn' ? -1 : 1))
	})).filter((g) => g.items.length);
	const warn_count = findings.filter((f) => f.severity === 'warn').length;

	// component memory join + counts
	const allocByName = new Map<string, number>();
	for (const h of extras.heap ?? []) allocByName.set(h.name, (allocByName.get(h.name) ?? 0) + h.self_bytes);
	// a component's bytes: everything allocated under it, nested components excluded
	for (const c of extras.heap_components ?? []) allocByName.set(c.name, c.bytes);
	const hasAlloc = allocByName.size > 0;
	const hasCounts = a.components.some((c) => c.calls != null) || a.functions.some((f) => f.calls != null);

	const withExtras = <T extends { name: string; total_ms: number; calls?: number }>(f: T) => {
		const count = f.calls ?? 0;
		return { ...f, per: f.total_ms / (count > 0 ? count : 1), count, alloc: allocByName.get(f.name) ?? null };
	};
	const compRows = a.components.map(withExtras);
	const fnRows = a.functions.slice(0, 80).map(withExtras);
	const compMaxTotal = Math.max(...a.components.map((c) => c.total_ms), 1);

	const stats: { value: string; label: string }[] = [
		{ value: fmt_ms(meta.duration_ms) + ' ms', label: 'window' },
		{ value: busy_pct.toFixed(0) + '%', label: 'CPU busy' },
		{ value: net.length ? fmt_ms(net_total) + ' ms' : '0', label: `network (${net.length} calls)` },
		{ value: fmt_ms(extras.gc_attr ? extras.gc_attr.summary.total_ms : a.gc_ms) + ' ms', label: 'garbage collection' },
		{ value: String(meta.requests.length), label: 'requests in window' }
	];
	if (extras.gc) stats.push({ value: fmt_ms(extras.gc.max_ms) + ' ms', label: `GC pause max (${extras.gc.count})` });
	if (meta.loop_delay) stats.push({ value: fmt_ms(meta.loop_delay.p99) + ' ms', label: 'loop delay p99' });
	if (meta.elu_percent !== undefined) stats.push({ value: meta.elu_percent.toFixed(0) + '%', label: 'event loop use' });
	if (meta.rss_mb !== undefined) stats.push({ value: meta.rss_mb + ' MB', label: 'memory (rss)' });
	stats.push({ value: String(a.sample_count), label: 'samples' });
	if (meta.overhead && meta.overhead.cpu_ms + meta.overhead.gc_ms > 0) stats.push({ value: `−${fmt_ms(meta.overhead.cpu_ms + meta.overhead.gc_ms)} ms`, label: `profiler's own cost, taken out${meta.overhead.per_run_ms ? ` (${fmt_ms(meta.overhead.per_run_ms)} ms per render)` : ''}` });

	const runsMedian =
		meta.trigger === 'page' && meta.runs?.length
			? [...meta.runs].sort((x, y) => x - y)[Math.floor(meta.runs.length / 2)]
			: 0;

	const budget = budget_segments(a);
	const tree = build_treemap(a);
	const legend = treemap_legend(a);
	const hosts = top_hosts(net).slice(0, 12);
	const netSorted = [...net]
		.sort((x, y) => y.ms + (y.body_ms ?? 0) - (x.ms + (x.body_ms ?? 0)))
		.slice(0, 60);
	const wf = waterfall_rows(net);
	const waiting = waiting_rows(net, extras.io ?? []);
	const spans = span_rows(extras.spans);
	const span_runs = meta.trigger === 'page' ? Math.max(meta.runs?.length ?? 1, 1) : 1;
	const tagged = meta.requests.filter((r) => r.tags && Object.keys(r.tags).length);
	const waitMax = waiting[0]?.ms || 1;
	const spark = build_spark(extras.mem);
	const measures = extras.measures ?? [];
	const heap = extras.heap ?? [];
	const files = a.files.filter((f) => f.category !== 'idle').slice(0, 25);
	const buckets = a.buckets.filter((b) => b.category !== 'idle').slice(0, 15);
	const maxBucket = Math.max(...a.buckets.map((b) => b.self_ms), 1);
	// the ogygia side of the page: islands (server + build + browser joined), the seed, the holes
	const islands = island_rows(a, meta, extras);
	const hasJs = islands.some((r) => r.js_bytes !== null);
	const hasClient = islands.some((r) => !!r.client);
	const flagged = islands.filter((r) => r.advice).length;
	const seed = seed_rows(meta);
	const holes = hole_rows(meta);
	const vitals = extras.vitals ?? null;
	const client_marks = extras.client_marks ?? [];
	// every island fingerprint on the page → its component name (the browser's pictures are keyed by fingerprint)
	const fp_names: Record<string, string> = {};
	for (const r of island_rows_of(meta)) fp_names[r.fp] = island_name(r);
	const visit = extras.visit ?? null;
	const server_clock = a.timeline ? { window_ms: a.timeline.window_ms, phases: a.timeline.phases.map((p) => ({ phase: p.phase, label: PHASE_LABEL[p.phase] ?? p.phase, cpu_ms: p.cpu_ms, wait_ms: p.wait_ms })) } : null;
	const page_path = meta.page ?? meta.request?.path ?? null;
	// WHO CAUSED THE GC: the pauses on the timeline's clock (the window starts `window_offset_ms` into the capture)
	const gc_attr = extras.gc_attr ?? null;
	const gc_ticks = gc_attr
		? gc_attr.pauses.map((p) => ({ t: p.t - (gc_attr.window_offset_ms ?? 0), ms: p.ms, kind: p.kind, why: p.why, top: p.top.slice(0, 3).map((x) => `${x.name}${x.component && x.component !== x.name ? ` in ${x.component}` : ''} ${Math.round(x.share * 100)}%`).join(', ') }))
		: [];
	// the pauses on the capture's clock, for the heap chart (it spans every run)
	const gc_on_capture = gc_attr ? gc_attr.pauses.map((p) => ({ t: p.t, ms: p.ms, kind: p.kind })) : [];
	// the scrubber's marks: the pauses inside the window, the few longest
	const scrub_marks = gc_ticks.filter((g) => g.t >= 0 && (a.timeline ? g.t <= a.timeline.window_ms : true)).sort((x, y) => y.ms - x.ms).slice(0, 8).map((g) => ({ t: g.t, label: `GC ${fmt_ms(g.ms)}` }));
	const fmt_mb = (b: number) => `${Math.round((b / 1048576) * 10) / 10} MB`;
	// more from the same snapshot: deopts, sync I/O, promises, memo candidates, what a render keeps
	const deopt_rows = a.deopts ?? [];
	const sync_rows = sync_io(a);
	const memo_rows = memo_candidates(a, gc_attr?.makers ?? []);
	const promises = extras.promises ?? null;
	const promises_per_render = promises ? Math.round(promises.count / Math.max(meta.runs?.length ?? 1, 1)) : 0;
	const retained = extras.retained ?? null;
	// the render step by step, when the heap grew, the instance's other requests, the data's lineage, the spans' values
	const steps = a.timeline ? (render_steps(a.timeline, a.stacks) ?? null) : null;
	const alloc = extras.alloc ?? null;
	const contention = extras.contention ?? null;
	const contention_others = contention ? contention.requests.filter((r) => r.kind === 'other').length : 0;
	const lineage = extras.lineage ?? null;
	const lineage_keys = lineage ? lineage.keys.slice(0, 40) : [];
	const value_rows = span_values(extras.spans);
	const cold = cold_rows(a, meta);
	const holes_seen = holes.some((h) => h.requests > 0);
	// page mode: N runs of one page → fold identical requests into one row with the count + medians
	const reqs = request_rows(meta.requests, meta.trigger === 'page').slice(0, 60);
	const folded = meta.trigger === 'page' && reqs.some((r) => r.count > 1);
	const title = `SSR profile — ${label_of(meta)}`;
	const VERDICT_LABEL: Record<string, string> = { island: 'read by an island', server: 'server only, not shipped', 'server-only': 'server only, but shipped', unread: 'nobody reads it', unknown: 'unknown' };
	const contention_self = contention ? contention.requests.filter((r) => r.kind === 'self').length : 0;
</script>

<svelte:head><title>{title}</title></svelte:head>

<Shell {base} current={meta.id} toc>
	<OnThisPage />

	<h1>
		SSR profile
		<small
			>{label_of(meta)} · {new Date(meta.created).toLocaleString()} · node {meta.node}{a.sourcemapped
				? ' · sourcemapped'
				: ''}</small
		>
	</h1>
	<div class="actions">
		{#if ogpB64}<ExportButton id={meta.id} {ogpB64} />{/if}
		{#if ogpB64}<ShareLink id={meta.id} {base} />{/if}
		<KeepLocal {base} id={meta.id} />
		<a
			class="btn"
			href="{base}/report/{meta.id}.html"
			download="ogygia-profile-{meta.id}.html"
			title="One HTML file with everything inlined — opens from disk, islands live. Built app only."
			>Download<span class="sub">.html</span></a
		>
		<a class="btn" href="{base}/view">Import<span class="sub">.ogp</span></a>
	</div>
	<p class="hint">
		<a href={base}>← dashboard</a> ·
		<a href="{base}/report/{meta.id}.json" download="ogygia-profile-{meta.id}.json">JSON</a> (agents) ·
		<a href="{base}/report/{meta.id}/raw" download="ogygia-profile-{meta.id}.cpuprofile">.cpuprofile</a>
		(DevTools / speedscope) · Export is an
		encrypted <code>.ogp</code> — re-open it with Import (needs this profiler's key)
	</p>

	<ScoreCard {score} />

	<div class="summary">
		{#each stats as st}<div class="stat"><b>{st.value}</b><span>{st.label}</span></div>{/each}
	</div>

	<!-- ═══════════════ 1 · WHAT TO FIX ═══════════════ -->
	<div class="part"><span class="part-n">1</span><span class="part-t">What to fix</span></div>

	{#if warn_count}<p class="findings-lead"><b>{warn_count}</b> thing{warn_count === 1 ? '' : 's'} worth fixing, grouped by area. The rest are context.</p>{/if}
	<div class="fgrid">
		{#each finding_groups as g (g.label)}
			<section class="fgroup">
				<h3 class="fgroup-h">{g.label} <span class="fgroup-n">{g.items.length}</span></h3>
				{#each g.items as f, i (f.code + i)}
					<div class="finding" class:warn={f.severity === 'warn'}>
						<p class="fmsg">{f.message}</p>
						{#if f.fix}<p class="ffix">{f.fix}</p>{/if}
						{#if f.anchor}<a class="fshow" href={row_href(f.anchor)}>show the row ↓</a>{/if}
						{#if f.file && !f.anchor}<span class="ffile">{f.file}{#if f.line}:{f.line}{/if}</span>{/if}
					</div>
				{/each}
			</section>
		{/each}
	</div>

	<div class="grid">
		<section class="panel">
			<h2>Where the time went</h2>
			<p class="hint">
				The whole window, wall-clock. If the biggest segment is "idle / waiting", the server was blocked on
				I/O, not computing — look at Network below. If it's "your code", the treemap and Components table show
				exactly where.
			</p>
			<div class="budget">
				{#each budget as s}
					<div
						style="width:{s.pct}%;background:{CATEGORY_COLOR[s.cat]}"
						title="{s.label} — {fmt_ms(s.ms)} ms ({s.pct.toFixed(1)}%)"
					>
						{s.pct > 8 ? `${s.label} ${s.pct.toFixed(0)}%` : ''}
					</div>
				{/each}
			</div>
			{#if busy_pct < 25}
				<p class="hint" style="color:var(--warn)">
					This window barely used the CPU ({busy_pct.toFixed(0)}% busy) — the bottleneck is <b>waiting</b>, not
					computing. Look at "Waiting by function" below; the treemap is just the small slice of real CPU work.
				</p>
			{/if}
		</section>
		{#if hist && hist_geom && hist_last && hist_prev}
			<section class="panel">
				<h2>History of {meta.page}</h2>
				<div class="history">
					<svg width={hist_geom.w} height={hist_geom.h} viewBox="0 0 {hist_geom.w} {hist_geom.h}">
						<polyline points={hist_geom.poly} fill="none" stroke="#6ca8e0" stroke-width="1.5" />
						{#each hist_geom.pts as [x, y], i (i)}
							<circle cx={x} cy={y} r="3" fill={hist[i].id === meta.id ? '#e0834a' : '#6ca8e0'}>
								<title>{fmt_ms(hist[i].median)} ms · {new Date(hist[i].created).toLocaleString()}</title>
							</circle>
						{/each}
					</svg>
					<div>
						<p class="hint">
							{hist.map((p) => fmt_ms(p.median) + ' ms').join(' → ')} (median render, oldest first).
							{#if Math.abs(hist_delta) >= 5}
								<b class={hist_delta > 0 ? 'warn' : 'good'}>{hist_delta > 0 ? '+' : ''}{hist_delta.toFixed(0)}%</b> against the previous run.
							{/if}
						</p>
						{#if prev}<a class="btn" href="{base}/compare/{prev}/{meta.id}">Compare with the previous run</a>{/if}
					</div>
				</div>
			</section>
		{/if}
	</div>

	{#if a.paths?.length}
		<section class="panel">
			<h2>Paths to fix <span class="hint" style="font-weight:400">({a.paths.length}: hot functions that share one caller)</span></h2>
			<p class="hint">
				The hot-functions table ranks them one by one, but several often sit on <b>one call path</b>: fix the caller
				they share and all of them go. Each graph reads left to right: the caller to fix, the chain of calls, the hot
				functions (lit) at the end. Link width is the time that flowed through; click a node for its row.
			</p>
			<Paths paths={a.paths} busy={a.busy_ms} />
		</section>
	{/if}

	<!-- ═══════════════ 2 · WHY IT TOOK THIS LONG ═══════════════ -->
	{#if a.timeline}
		<div class="part"><span class="part-n">2</span><span class="part-t">Why it took this long</span></div>
		<section class="panel">
		<h2>Why this render took {fmt_ms(a.timeline.window_ms)} ms</h2>
		<p class="hint">
			One render, left to right, start to end. Each block is a stretch of time: solid means the CPU was
			running the thing named on it, striped means the server was waiting for a call to come back. The
			numbered steps below are the same blocks in order — the biggest is the one to fix first.
		</p>
		<Timeline t={a.timeline} gc={gc_ticks} />
		{#if a.timeline.awaits && a.timeline.awaits.nodes.length >= 2}
			<h3 class="sub-h">Which call waited for which <span class="hint">the render's calls on one clock, arrows where one started only after another finished</span></h3>
			<Awaits nodes={a.timeline.awaits.nodes} edges={a.timeline.awaits.edges} window_ms={a.timeline.window_ms} />
		{/if}
		{#if a.stacks}
			<h3 class="sub-h">Slice it <span class="hint">the render's CPU samples themselves — drag a range for what ran there, hover for the stack at that instant</span></h3>
			<p class="hint">
				Every table in this report is an aggregate over the whole render. This is the same data before aggregation:
				{a.stacks.raw.toLocaleString()} samples, each with its stack. Slice the busy stretch on the strip and the
				tables answer for that stretch alone; the yellow marks are the collections.
			</p>
			<Scrub stacks={a.stacks} marks={scrub_marks} />
		{/if}
		{#if steps && steps.steps.length > 1}
			<h3 class="sub-h">Step through it <span class="hint">the same render as a sequence: this ran, then the server waited for that, then…</span></h3>
			<RenderSteps {steps} />
		{/if}
		</section>
	{/if}

	{#if contention && contention.requests.length}
		<section class="panel">
		<h2>The instance was not alone <span class="hint" style="font-weight:400">({contention.requests.length} request{contention.requests.length === 1 ? '' : 's'} ran here during the profiled render{(meta.runs?.length ?? 1) > 1 ? 's' : ''}{#if contention_self}: {contention_self} the page's own calls to itself{/if}{#if contention_others}, {contention_others} from elsewhere{/if})</span></h2>
		<p class="hint">
			One Node process, one event loop: every other request's turn on the CPU is a wait inside the render's wall
			time with no frame of its own. Something else was in flight for <b>{Math.round(contention.busy_share * 100)}%</b>
			of the window{#if contention.cpu_max_ms > 0}, taking up to <b>{fmt_ms(contention.cpu_max_ms)} ms</b> of CPU from it (an
				upper bound — a request's CPU is a process-wide delta, so overlapping requests carry some of each other's){/if}.
			{#if contention_others === 0}None of them is a stranger: they are the page's own calls to this same server, and its holes — the render waited on itself.{/if}
			The CPU tables above exclude the others; the wall time does not.
		</p>
		<table>
			<thead><tr><th>request</th><th>route</th><th class="num">status</th><th class="num">ms</th><th class="num">overlapped</th><th class="num">CPU, at most</th><th>what</th></tr></thead>
			<tbody>
				{#each contention.requests.slice(0, 20) as r, i (i)}
					<tr>
						<td class="fn">{r.method} {r.path}</td>
						<td class="file">{r.route ?? '—'}</td>
						<td class="num">{r.status || '—'}</td>
						<td class="num">{fmt_ms(r.ms)}</td>
						<td class="num"><b>{fmt_ms(r.overlap_ms)}</b></td>
						<td class="num">{fmt_ms(r.cpu_max_ms)}</td>
						<td class="hint">{r.kind === 'hole' ? "one of the page's own holes" : r.kind === 'self' ? 'the render calling its own server' : 'another request'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if contention.inflight_at_start.some((n) => n > 0)}
			<p class="hint">In flight when each profiled render started: {contention.inflight_at_start.join(', ')}.</p>
		{/if}
		</section>
	{/if}

	<!-- ═══════════════ 3 · MEMORY ═══════════════ -->
	{#if spark}
		<div class="part"><span class="part-n">3</span><span class="part-t">Memory</span></div>
		{#if gc_attr && (gc_attr.pauses.length || gc_attr.makers.length)}
			<section class="panel">
			<h2>Who caused the GC <span class="hint" style="font-weight:400">(each pause joined to what filled the heap before it)</span></h2>
			<div class="summary">
				<div class="stat"><b>{gc_attr.summary.count}</b><span>pauses · {gc_attr.summary.minor} minor · {gc_attr.summary.major} major{gc_attr.summary.incremental ? ` · ${gc_attr.summary.incremental} incremental` : ''}</span></div>
				<div class="stat"><b>{fmt_ms(gc_attr.summary.total_ms)} ms</b><span>in GC · longest {fmt_ms(gc_attr.summary.max_ms)} ms</span></div>
				<div class="stat"><b>{gc_attr.summary.allocated_mb} MB</b><span>allocated in the window · {gc_attr.summary.alloc_rate_mb_s} MB/s</span></div>
				{#if gc_attr.summary.retained_mb !== undefined}<div class="stat"><b>{gc_attr.summary.retained_mb > 0 ? '+' : ''}{gc_attr.summary.retained_mb} MB</b><span>heap held at the end vs the start{gc_attr.summary.retained_mb <= 5 ? ' — the rest was churn' : ' — something keeps what it allocates'}</span></div>{/if}
				{#if gc_attr.summary.overhead_ms >= 0.5}<div class="stat"><b>−{fmt_ms(gc_attr.summary.overhead_ms)} ms</b><span>the profiler's own garbage, taken out ({fmt_ms(gc_attr.summary.measured_ms)} ms measured)</span></div>{/if}
			</div>
			{#if gc_attr.makers.length}
				{@const with_pauses = gc_attr.makers.some((m) => m.pauses > 0)}
			{@const with_comp = gc_attr.makers.some((m) => m.component)}
				<h3 class="sub-h">Garbage makers <span class="hint">allocators by the pause time their allocations caused</span></h3>
				<table>
					<thead><tr><th>function</th>{#if with_comp}<th>in</th>{/if}<th>where</th><th class="num">allocated</th><th class="num">share</th><th class="num">GC ms caused</th>{#if with_pauses}<th class="num">pauses</th>{/if}</tr></thead>
					<tbody>
						{#each gc_attr.makers.slice(0, 20) as m (m.key)}
							<tr>
								<td class="fn"><b>{m.name}</b>{#if m.caller && m.caller !== m.name}<span class="hint"> ← {m.caller}</span>{/if}</td>
								{#if with_comp}<td class="fn">{m.component ?? '—'}</td>{/if}
								<td class="file">{m.url ? `${m.url.split('/').slice(-3).join('/')}:${m.line}` : ''} <span class="hint">{m.category}</span></td>
								<td class="num">{fmt_mb(m.allocated)}</td>
								<td class="num">{Math.round(m.share * 100)}%</td>
								<td class="num"><b>{fmt_ms(m.gc_ms)}</b></td>
								{#if with_pauses}<td class="num">{m.pauses}</td>{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
			{#if gc_attr.components.length}
				<p class="hint">By component: {#each gc_attr.components.slice(0, 6) as c, i (c.name)}{#if i > 0}, {/if}<b>{c.name}</b> {fmt_ms(c.gc_ms)} ms of GC for {fmt_mb(c.allocated)}{/each}.</p>
			{/if}
			{#if gc_attr.pauses.length}
				<h3 class="sub-h">The pauses <span class="hint">when, what kind, and what was allocated since the previous one</span></h3>
				<table>
					<thead><tr><th class="num">at</th><th>kind</th><th class="num">ms</th><th class="num">allocated before</th><th>why</th><th>running then</th></tr></thead>
					<tbody>
						{#each gc_attr.pauses.slice(0, 40) as p, i (i)}
							<tr>
								<td class="num">{fmt_ms(p.t - (gc_attr.window_offset_ms ?? 0))} ms</td>
								<td class="fn">{p.kind}{p.forced ? ' (forced)' : ''}</td>
								<td class="num"><b>{fmt_ms(p.ms)}</b>{#if p.ms_measured - p.ms >= 0.5}<span class="hint"> ({fmt_ms(p.ms_measured)} measured)</span>{/if}</td>
								<td class="num">{p.estimated ? '≈' : ''}{fmt_mb(p.allocated)}</td>
								<td class="file">{p.why}</td>
								<td class="fn">{#if p.top.length}{#each p.top.slice(0, 3) as x, j (x.key)}{#if j > 0}, {/if}{x.name}{#if x.component && x.component !== x.name} <span class="hint">in {x.component}</span>{/if} {Math.round(x.share * 100)}%{/each}{:else if p.running}<b>{p.running.label}</b>{#if p.running.file} <span class="hint">{p.running.file.split('/').slice(-2).join('/')}</span>{/if}{:else}—{/if}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				{#if gc_attr.pauses.length > 40}<p class="hint">and {gc_attr.pauses.length - 40} more pauses.</p>{/if}
			{/if}
			<p class="hint">
				A minor pause happens when the young space fills; a major one when the old space grows. Who allocated comes from one read of the allocation profile at the end of the window (reading it during the work set off collections of its own), so "GC ms caused" gives each allocator its share of the pauses by its share of everything allocated, and a pause's "allocated before" is the window's rate over the stretch since the previous pause. "Running then" is what the CPU was doing when the pause fell, from the timeline. The profiler's own allocations are taken out of every pause.
			</p>
			</section>
		{/if}
		{#if alloc}
			<section class="panel">
			<h2>When the heap grew <span class="hint" style="font-weight:400">(the used heap over the whole recording, and the stretches it grew fastest — with what ran then)</span></h2>
			<AllocStrip {alloc} gc={gc_on_capture} />
			</section>
		{/if}
		{#if retained}
			<section class="panel">
			<h2>What a render leaves behind <span class="hint" style="font-weight:400">(one more render, a full collection, then what is still alive — by the line that made it)</span></h2>
			<div class="summary">
				<div class="stat"><b>{fmt_mb(retained.total_bytes)}</b><span>still alive after the render and a full collection</span></div>
				<div class="stat"><b>{fmt_ms(retained.render_ms)} ms</b><span>that render (outside the runs)</span></div>
			</div>
			{#if retained.sites.length}
				<table>
					<thead><tr><th>allocated by</th><th>in</th><th>where</th><th class="num">kept</th><th class="num">share</th></tr></thead>
					<tbody>
						{#each retained.sites.slice(0, 15) as s, i (i)}
							<tr>
								<td class="fn"><b>{s.name}</b>{#if s.caller && s.caller !== s.name}<span class="hint"> ← {s.caller}</span>{/if}</td>
								<td class="fn">{s.component ?? '—'}</td>
								<td class="file">{s.url ? `${s.url.split('/').slice(-3).join('/')}:${s.line}` : ''}</td>
								<td class="num">{fmt_mb(s.bytes)}</td>
								<td class="num">{Math.round(s.share * 100)}%</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
			<p class="hint">
				These objects were made by one render and something still holds them after a full collection: a module-level cache, a registry, a closure kept by a long-lived object. The line is where they were made; their owner is what keeps them. A page that keeps this much per render grows until the instance restarts.
			</p>
			</section>
		{/if}
	{/if}

	<!-- ═══════════════ 4 · HIDDEN COSTS ═══════════════ -->
	{#if sync_rows.length || promises_per_render >= 1000 || memo_rows.length || deopt_rows.length}
		<div class="part"><span class="part-n">4</span><span class="part-t">Hidden costs</span><span class="hint">what no single hot function shows</span></div>
		<div class="grid">
			{#if sync_rows.length}
				<section class="panel">
					<h3>Synchronous I/O in the render <span class="hint">blocks every other request on the instance while it runs</span></h3>
					<table>
						<thead><tr><th>call</th><th>module</th><th class="num">calls</th><th class="num">ms</th><th>from</th></tr></thead>
						<tbody>
							{#each sync_rows as s (s.key)}
								<tr><td class="fn"><a href={row_href(`fn:${s.key}`)}><b>{s.name}</b></a></td><td class="file">{s.module}</td><td class="num">{s.calls ?? '—'}</td><td class="num">{fmt_ms(s.total_ms)}</td><td class="file">{s.callers.join(' ← ') || '—'}</td></tr>
							{/each}
						</tbody>
					</table>
				</section>
			{/if}
			{#if memo_rows.length}
				<section class="panel">
					<h3>Memoization candidates <span class="hint">called many times per render at a steady cost each — if the result depends only on the argument, cache it</span></h3>
					<table>
						<thead><tr><th>function</th><th>where</th><th class="num">/ render</th><th class="num">per call</th><th class="num">total ms</th><th class="num">alloc / call</th><th>under</th></tr></thead>
						<tbody>
							{#each memo_rows as m (m.key)}
								<tr><td class="fn"><a href={row_href(`fn:${m.key}`)}><b>{m.name}</b></a></td><td class="file">{m.url}:{m.line}</td><td class="num">{m.calls}</td><td class="num">{m.per_call_ms} ms</td><td class="num">{fmt_ms(m.total_ms)}</td><td class="num">{m.alloc_per_call ? fmt_bytes(m.alloc_per_call) : '—'}</td><td class="fn">{m.parent ?? '—'}</td></tr>
							{/each}
						</tbody>
					</table>
				</section>
			{/if}
			{#if deopt_rows.length}
				<section class="panel">
					<h3>Deoptimizations <span class="hint">functions V8 threw out of optimized code, and why</span></h3>
					<table>
						<thead><tr><th>function</th><th>where</th><th class="num">times</th><th>reasons</th><th class="num">self ms</th></tr></thead>
						<tbody>
							{#each deopt_rows.slice(0, 20) as d (d.key)}
								<tr>
									<td class="fn"><a href={row_href(`fn:${d.key}`)}><b>{d.name}</b></a></td>
									<td class="file">{d.url}{#if d.line > 0}:{d.line}{/if} <span class="hint">{CATEGORY_LABEL[d.category]}</span></td>
									<td class="num">{d.count}</td>
									<td class="fn">{Object.entries(d.reasons).sort((x, y) => y[1] - x[1]).map(([r, n]) => `${r} ×${n}`).join(', ')}</td>
									<td class="num">{fmt_ms(d.self_ms)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
					<p class="hint">"wrong map": objects of different shapes reach one site — keep the same properties in the same order. "not a Smi": a number changed kind. A function that deoptimizes every render runs slow every render.</p>
				</section>
			{/if}
			{#if promises && promises_per_render >= 1000}
				<section class="panel">
					<h3>Promises <span class="hint">each an allocation and a microtask</span></h3>
					<p><b class="big">{promises_per_render.toLocaleString()}</b> <span class="hint">created per render</span></p>
					{#if promises.top.length}
						<p class="hint">Mostly from: {#each promises.top.slice(0, 5) as t, i (t.caller)}{#if i > 0}, {/if}<b>{t.caller}</b> {Math.round(t.share * 100)}%{/each} <span class="hint">(one stack in 256 promises is captured; the shares are of those)</span></p>
					{/if}
				</section>
			{/if}
		</div>
	{/if}

	<!-- ═══════════════ 5 · THE DATA ═══════════════ -->
	{#if lineage || (extras.river && extras.river.nodes.length) || (og && seed && seed.rows.length) || extras.strip}
		<div class="part"><span class="part-n">5</span><span class="part-t">The data</span></div>
	{/if}
	{#if lineage}
		<section class="panel">
		<h2>Who reads what <span class="hint" style="font-weight:400">(every page.data key: the load that made it, the components that read it, from their sources)</span></h2>
		<p class="hint">
			A key read by an island must ship in the seed. A key read only on the server is rendered into the HTML and need not
			ship. A key nobody reads was fetched for no one — the load's wait behind it is pure waste. The readers come from
			scanning the route's page and layouts and every component the profile saw; the islands' reads are what the page's
			own seed explainer recorded, so the two agree. An island that reads the page whole makes every key "unknown".
		</p>
		<table>
			<thead><tr><th>key</th><th>from</th><th class="num">shipped</th><th class="num">load waited</th><th>read by</th><th>verdict</th></tr></thead>
			<tbody>
				{#each lineage_keys as k (k.key)}
					<tr>
						<td class="fn"><code>{k.key}</code></td>
						<td class="file">{k.from ?? '—'}</td>
						<td class="num">{k.shipped_bytes ? fmt_bytes(k.shipped_bytes) : '—'}</td>
						<td class="num">{k.load_wait_ms === null ? '—' : fmt_ms(k.load_wait_ms) + ' ms'}</td>
						<td class="fn">{#each k.readers.slice(0, 5) as r, i (r.name)}{#if i > 0}, {/if}{r.name}{#if r.island}<span class="hint"> (island)</span>{/if}{:else}<span class="hint">—</span>{/each}{#if k.readers.length > 5}<span class="hint"> +{k.readers.length - 5}</span>{/if}</td>
						<td><span class="lverdict" class:warn={k.verdict === 'unread'} class:note={k.verdict === 'server-only'} class:good={k.verdict === 'island'}>{VERDICT_LABEL[k.verdict] ?? k.verdict}</span></td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if lineage.keys.length > 40}<p class="hint">and {lineage.keys.length - 40} more keys.</p>{/if}
		{#if lineage.notes.length}<p class="hint">{#each lineage.notes as n, i (i)}{n} {/each}</p>{/if}
		<p class="hint scanned">Scanned: {#each lineage.components as c, i (c.file)}{#if i > 0}, {/if}<span title={c.file}>{c.name}</span>{#if c.reads === null}<span class="hint"> (?)</span>{:else if c.whole}<span class="hint"> (whole)</span>{:else}<span class="hint"> ({c.reads.length})</span>{/if}{/each}.</p>
		</section>
	{/if}
	{#if extras.river && extras.river.nodes.length}
		<section class="panel">
		<h2>The data river <span class="hint" style="font-weight:400">(upstream calls → loads → page.data keys → the islands that read them)</span></h2>
		<DataRiver river={extras.river} />
		</section>
	{/if}
	{#if og && seed && seed.rows.length}
		<section class="panel">
		<h2>The seed, explained <span class="hint" style="font-weight:400">({fmt_kb(og.seed_bytes)}{#if og.seed_culprit} · devalue because of <code>{og.seed_culprit}</code>{:else if og.seed_json} · json{/if})</span></h2>
		<p class="hint">
			Every top-level <code>page.data</code> key, sized, and why it ships: <span style="color:#e8734a">read</span> by an island's
			client code, <span style="color:#5b8fd6">referenced</span> by an island's props, or <span style="color:#d9a03d">whole</span>
			because an island reads page.data without naming keys. Greyed keys were left out by seed shaping.
		</p>
		<SeedExplainer rows={seed.rows} whole_by={seed.whole_by} total={seed.total} seed_bytes={og.seed_bytes} />
		</section>
	{/if}
	{#if extras.strip}
		<section class="panel">
		<h2>The document, byte by byte <span class="hint" style="font-weight:400">({fmt_bytes(extras.strip.total)} — what each byte the server wrote is, in the order it left)</span></h2>
		<ByteStrip strip={extras.strip} names={fp_names} nav={visit ? { res_start: visit.nav.res_start, res_end: visit.nav.res_end } : null} />
		</section>
	{/if}

	<!-- ═══════════════ 6 · ISLANDS AND THE BROWSER ═══════════════ -->
	{#if og || islands.length || (meta.trigger === 'page' && meta.runs?.length && (page_path || vitals || client_marks.length)) || extras.client_cpu}
		<div class="part"><span class="part-n">6</span><span class="part-t">Islands and the browser</span></div>
	{/if}
	{#if og}
		<section class="panel">
		<h2>ogygia's own cost</h2>
		<p class="hint">
			What the handle added to this page — the transform's own time and every byte it put in the document.
			The seed ships only when an island reads <code>$page</code>; props cross once per island.
		</p>
		<div class="summary">
			<div class="stat"><b>{fmt_ms(og.transform_ms)} ms</b><span>transform</span></div>
			<div class="stat"><b>{og.islands}</b><span>islands</span></div>
			{#if og.holes}<div class="stat"><b>{og.holes}</b><span>holes</span></div>{/if}
			<div class="stat"><b>{fmt_kb(og.seed_bytes)}</b><span>page seed{og.seed_bytes ? (og.seed_json ? ' (json)' : ' (devalue)') : ''}</span></div>
			<div class="stat"><b>{fmt_kb(og.tail_bytes)}</b><span>props + hints</span></div>
			{#if og.remote_seed_bytes}<div class="stat"><b>{fmt_kb(og.remote_seed_bytes)}</b><span>remote seed</span></div>{/if}
			{#if og.fnm_bytes}<div class="stat"><b>{fmt_kb(og.fnm_bytes)}</b><span>fn manifest</span></div>{/if}
			{#if og.ctx_bytes}<div class="stat"><b>{fmt_kb(og.ctx_bytes)}</b><span>context bridge</span></div>{/if}
		</div>
		</section>

		{#if islands.length}
			<section class="panel">
			<h2>Islands <span class="hint" style="font-weight:400">({islands.length}{#if flagged}, {flagged} with advice{/if}, click a column to sort)</span></h2>
			<p class="hint">
				One row per island — its copies merge, however many props sidecars they ship (<b>×N</b>). <b>SSR ms</b> is the component's server render per
				page render; <b>props</b> is what the sidecar ships; <b>seed refs</b> are props that point into page.data instead
				of shipping twice{#if hasJs}; <b>JS</b> is the unique weight of the island's module and its preloads{/if};
				<b>interactivity</b> is what the build found in its components — an <span style="color:#d9a03d">inert</span> island
				loads JS for markup that never changes{#if hasClient}; <b>hydrate ms</b> is what your own browser reported (wake to
				hydrated, p50){:else}. Open the page in this browser while logged in and the runtime reports each island's hydration
				time back here{/if}. A <span class="dotflag-inline">!</span> marks a row with advice — open it.
			</p>
			<IslandsTable rows={islands} {hasJs} {hasClient} />
			</section>
		{/if}

		{#if holes.length}
			<section class="panel">
			<h2>Holes <span class="hint" style="font-weight:400">({holes.length} deferred)</span></h2>
			<p class="hint">
				A hole ships its fallback in the page and renders on the islands endpoint afterwards. Each is named by its component
				and props, the way it is written in the page.{#if holes_seen}
					The endpoint requests that landed in this window say what its render cache did.{:else}
					No endpoint requests landed in this window — open the page in a browser during a recording, or profile the hole's
					URL, to see hits and misses.{/if}
			</p>
			<table>
				<thead>
					<tr><th>hole</th><th>fetch</th><th>then wakes</th><th class="num">maxAge</th><th class="num">copies</th><th class="num">requests</th><th class="num">avg ms</th><th>cache</th></tr>
				</thead>
				<tbody>
					{#each holes as h (h.id)}
						<tr>
							<td class="fn">
								{#if h.name}<b>{h.name}</b>{#if h.props} <code class="props">{h.props}</code>{/if}<span class="hint"> · {h.id}</span>{:else}<code>{h.id}</code>{/if}
							</td>
							<td>{h.when}</td>
							<td>{h.hydrate ?? '—'}</td>
							<td class="num">{h.ttl ? `${h.ttl}s` : '—'}</td>
							<td class="num">{h.count}</td>
							<td class="num">{h.requests || '—'}</td>
							<td class="num">{h.avg_ms === null ? '—' : fmt_ms(h.avg_ms)}</td>
							<td>
								<span class="hverdict" class:warn={h.ttl > 0 && h.requests >= 2 && h.hit === 0} class:good={h.hit > 0}>{h.verdict}</span>
								{#if h.requests}<span class="hint"> · {h.hit} hit · {h.miss} miss{#if h.none} · {h.none} uncached{/if}</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			</section>
		{/if}
	{/if}
	{#if islands.length}
		<section class="panel">
		<h2>Island cost heatmap <span class="hint" style="font-weight:400">(every cost of every island on one grid — click a column to sort by it)</span></h2>
		<IslandHeatmap rows={islands} {visit} />
		</section>
	{/if}
	{#if page_path && islands.length}
		<section class="panel">
		<h2>DOM time travel <span class="hint" style="font-weight:400">(each island's markup as the server sent it, after it hydrated, when the page left — and the layout shifts, mapped)</span></h2>
		<DomTravel page={page_path} names={fp_names} {visit} />
		</section>
	{/if}

	{#if meta.trigger === 'page' && meta.runs?.length}
		{#if page_path}
			<section class="panel">
			<h2>One clock <span class="hint" style="font-weight:400">(the server's render, the HTML arriving, every file, the main thread, each island waking, the paints — from the click)</span></h2>
			<OneClock server={server_clock} {visit} page={page_path} names={fp_names} />
			</section>
		{/if}
		{#if vitals}
			<section class="panel">
			<h2>In the browser <span class="hint" style="font-weight:400">(what your own visits to this page measured, p50 of {vitals.n})</span></h2>
			<div class="summary">
				<div class="stat"><b>{vitals.ttfb === null ? '—' : fmt_ms(vitals.ttfb) + ' ms'}</b><span>TTFB</span></div>
				<div class="stat"><b>{vitals.fcp === null ? '—' : fmt_ms(vitals.fcp) + ' ms'}</b><span>first paint</span></div>
				<div class="stat"><b>{vitals.lcp === null ? '—' : fmt_ms(vitals.lcp) + ' ms'}</b><span>LCP</span></div>
				<div class="stat"><b>{vitals.cls === null ? '—' : vitals.cls}</b><span>CLS</span></div>
				<div class="stat"><b>{vitals.inp === null ? '—' : fmt_ms(vitals.inp) + ' ms'}</b><span>INP</span></div>
				<div class="stat"><b>{fmt_ms(runsMedian)} ms</b><span>server render (median)</span></div>
			</div>
			<p class="hint">
				TTFB minus the render is what sits in front of this server (a cold instance, a proxy, the network); LCP minus
				TTFB is what the browser does after the HTML arrives (assets, fonts, hydration).
			</p>
			</section>
		{/if}
		{#if client_marks.length}
			<section class="panel">
			<h3 class="sub-h">Marked in the browser <span class="hint">what the app timed itself with <code>mark()</code>, p50 over your visits</span></h3>
			<table>
				<thead><tr><th>mark</th><th class="num">seen</th><th class="num">p50 ms</th><th class="num">max ms</th><th class="num">failed</th><th>attributes</th></tr></thead>
				<tbody>
					{#each client_marks as m (m.name)}
						<tr>
							<td class="fn"><b>{m.name}</b></td>
							<td class="num">{m.n}</td>
							<td class="num"><b>{fmt_ms(m.p50_ms)}</b></td>
							<td class="num">{fmt_ms(m.max_ms)}</td>
							<td class="num" class:warn={m.errors > 0}>{m.errors || '—'}</td>
							<td class="hint">{m.attr_keys.join(', ') || '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			</section>
		{/if}
	{/if}

	{#if extras.client_cpu}
		{@const c = extras.client_cpu.analysis}
		{@const cRows = c.components.map((f) => ({ ...f, per: f.total_ms / Math.max(f.calls ?? 1, 1), count: f.calls ?? 0, alloc: null }))}
		{@const fRows = c.functions.slice(0, 60).map((f) => ({ ...f, per: f.total_ms / Math.max(f.calls ?? 1, 1), count: f.calls ?? 0, alloc: null }))}
		<section class="panel">
		<h2>In the browser: CPU while the page hydrated</h2>
		<p class="hint">
			Your own browser's main thread, sampled every 10 ms for the first seconds of the visit ({new Date(extras.client_cpu.at).toLocaleTimeString()}), the same
			way the server is: components by their hydration cost, the functions under them, and a flame graph. This is where the
			islands' hydrate times come from. A visitor is never sampled.
		</p>
		<div class="summary">
			<div class="stat"><b>{fmt_ms(c.duration_ms)} ms</b><span>sampled</span></div>
			<div class="stat"><b>{fmt_ms(c.busy_ms)} ms</b><span>main thread busy</span></div>
			<div class="stat"><b>{c.duration_ms > 0 ? ((c.busy_ms / c.duration_ms) * 100).toFixed(0) : 0}%</b><span>busy</span></div>
			<div class="stat"><b>{c.components.length}</b><span>components seen</span></div>
		</div>
		{#if cRows.length}
			<h3 class="sub-h">Components <span class="hint">by hydration cost in the browser</span></h3>
			<ComponentsTable rows={cRows} busy={c.busy_ms} hasAlloc={false} maxTotal={Math.max(...cRows.map((r) => r.total_ms), 1)} {base} dev={false} />
		{/if}
		<h3 class="sub-h">Hot functions <span class="hint">in the browser</span></h3>
		<FunctionsTable rows={fRows} hasAlloc={false} {base} dev={false} />
		<h3 class="sub-h">Flame graph <span class="hint">the browser's main thread</span></h3>
		<Flame flame={c.flame} />
		</section>
	{/if}

	<!-- ═══════════════ 7 · NETWORK AND WAITS ═══════════════ -->
	<div class="part"><span class="part-n">7</span><span class="part-t">Network and waits</span></div>
	<section class="panel">
	<h2>Network</h2>
	{#if net.length}
		<p class="hint">
			Every outbound call the server made during the window, tied to the route that made it. "wait" =
			until headers arrived; "body" = reading the response.{#if meta.trigger === 'page' && (meta.runs?.length ?? 0) > 1}
				Shown for one representative render (of {meta.runs?.length ?? 0}).{/if}
		</p>
		{#if wf.length}
			<p class="hint">Each bar is one request, sized by its response. Click a bar for its trigger, sizes, headers, and payload.</p>
			<Waterfall rows={wf} />
		{/if}
		<table>
			<thead>
				<tr
					><th>host</th><th class="num">calls</th><th class="num">total ms</th><th class="num">p50</th
					><th class="num">max</th><th class="num">errors</th></tr
				>
			</thead>
			<tbody>
				{#each hosts as h}
					<tr>
						<td class="fn">{h.host || '(same process)'}</td>
						<td class="num">{h.count}</td>
						<td class="num"><b>{fmt_ms(h.total)}</b></td>
						<td class="num">{fmt_ms(h.p50)}</td>
						<td class="num">{fmt_ms(h.max)}</td>
						<td class="num">{h.errors || '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="hint">
			No outbound HTTP calls seen in this window. If requests are still slow while the CPU is idle, the
			wait is inside a database/socket driver or a timer.
		</p>
	{/if}
	</section>

	{#if spans.length}
		<section class="panel">
		<h2>Spans <span class="hint" style="font-weight:400">(what the app named with <code>span()</code>)</span></h2>
		<p class="hint">
			The waits the profiler cannot see on its own, named in the code. Per render: count and time are
			divided by the {span_runs} render{span_runs === 1 ? '' : 's'} in this recording. A span appears on the
			timeline as "in &lt;name&gt;" wherever a call or a gap sits inside it. <b>total</b> is the spans' summed
			duration, <b>self</b> is that minus the child spans inside them, <b>wall</b> counts overlaps once (∥ marks spans
			that ran together): wall is what the render paid. A span that carries an attribute with a few distinct
			values (a tag, a table, a key) gets a <b>by</b> table under it: what each value cost.
		</p>
		<table>
			<thead>
				<tr
					><th>span</th><th>called from</th><th class="num">per render</th><th class="num" title="the spans' summed duration per render">total ms</th
					><th class="num" title="minus the child spans inside it — its own time">self ms</th><th class="num" title="overlaps counted once — what it cost the render">wall ms</th
					><th class="num">p50</th><th class="num">max</th><th>cache</th><th class="num">errors</th></tr
				>
			</thead>
			<tbody>
				{#each spans as s (s.name)}
					<tr>
						<td class="fn"><b>{s.name}</b>{#if s.attr_keys.length}<span class="hint"> · {s.attr_keys.join(', ')}</span>{/if}</td>
						<td class="file">{s.callers[0] ?? '—'}{#if s.callers.length > 1}<span class="hint"> +{s.callers.length - 1}</span>{/if}</td>
						<td class="num">{(s.count / span_runs) % 1 === 0 ? s.count / span_runs : (s.count / span_runs).toFixed(1)}</td>
						<td class="num">{fmt_ms(s.total_ms / span_runs)}</td>
						<td class="num" class:dimcell={s.self_ms < s.total_ms * 0.2}>{fmt_ms(s.self_ms / span_runs)}</td>
						<td class="num"><b>{fmt_ms(s.wall_ms / span_runs)}</b>{#if s.count > 1 && s.wall_ms < s.total_ms * 0.6}<span class="hint" title="the spans overlap: they ran together"> ∥</span>{/if}</td>
						<td class="num">{fmt_ms(s.p50_ms)}</td>
						<td class="num">{fmt_ms(s.max_ms)}</td>
						<td>{#if s.cache}{s.cache.hit} hit · <span class:warn={s.cache.miss > 0}>{s.cache.miss} miss</span>{:else}—{/if}</td>
						<td class="num">{s.errors || (s.open ? `${s.open} open` : '—')}</td>
					</tr>
					{#each Object.entries(s.by) as [k, rows] (k)}
						<tr class="by">
							<td colspan="10">
								<div class="bygrid">
									<div class="byh">by {k}</div>
									<div class="byh"></div>
									<div class="byh num" title="overlaps counted once">wall ms</div>
									<div class="byh num" title="summed durations">total ms</div>
									<div class="byh num">per render</div>
									<div class="byh num">p50</div>
									<div class="byh num">max</div>
									{#each rows as r (r.value)}
										<div class="byv"><code>{r.value}</code></div>
										<div class="bybar"><i style="width:{Math.max(1, (r.wall_ms / Math.max(rows[0].wall_ms, 0.01)) * 100)}%"></i></div>
										<div class="num"><b>{fmt_ms(r.wall_ms / span_runs)}</b></div>
										<div class="num">{fmt_ms(r.total_ms / span_runs)}</div>
										<div class="num">{(r.count / span_runs) % 1 === 0 ? r.count / span_runs : (r.count / span_runs).toFixed(1)}×</div>
										<div class="num">{r.p50_ms ? fmt_ms(r.p50_ms) : '—'}</div>
										<div class="num">{fmt_ms(r.max_ms)}</div>
									{/each}
								</div>
							</td>
						</tr>
					{/each}
				{/each}
			</tbody>
		</table>
		{#if value_rows.length}
			<h3 class="sub-h">Values, not just functions <span class="hint">the numbers the spans carried, and how the time moved with them</span></h3>
			<p class="hint">
				A span that reports a number (<code>rows</code>, <code>tags</code>, <code>bytes</code>) is measured against it here:
				<b>ms per unit</b> is the slope of a straight line through the spans, <b>fit</b> how well the line holds (1 = the value
				alone sets the time). A steep, well-fitting line says the cost is the size of the input; cut the input and the span follows.
			</p>
			<table>
				<thead><tr><th>span</th><th>attribute</th><th class="num">spans</th><th class="num">min</th><th class="num">p50</th><th class="num">max</th><th class="num">sum</th><th class="num">ms per unit</th><th class="num">fit</th></tr></thead>
				<tbody>
					{#each value_rows.slice(0, 30) as v (v.span + '.' + v.attr)}
						<tr>
							<td class="fn"><b>{v.span}</b></td>
							<td class="fn"><code>{v.attr}</code></td>
							<td class="num">{v.n}</td>
							<td class="num">{v.min}</td>
							<td class="num">{v.p50}</td>
							<td class="num">{v.max}</td>
							<td class="num">{v.sum}</td>
							<td class="num">{v.ms_per_unit === undefined ? '—' : v.ms_per_unit >= 0.01 ? v.ms_per_unit : v.ms_per_unit.toExponential(1)}</td>
							<td class="num" class:good={v.r !== undefined && v.r >= 0.8}>{v.r === undefined ? '—' : v.r}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
		</section>
	{/if}

	{#if waiting.length}
		<section class="panel">
		<h2>Waiting by function <span class="hint" style="font-weight:400">(click a column to sort)</span></h2>
		<p class="hint">
			Where the server WAITED (not computed), attributed to the function that started the I/O. A big
			number here with idle CPU is your bottleneck.
		</p>
		<WaitingTable rows={waiting} maxMs={waitMax} />
		</section>
	{/if}

	<!-- ═══════════════ 8 · THE RAW NUMBERS ═══════════════ -->
	<div class="part"><span class="part-n">8</span><span class="part-t">The raw numbers</span><span class="hint">everything above is an aggregate of these</span></div>

	<section class="panel">
	<h2>CPU by self time</h2>
	<p class="hint">
		Every box is real work; the biggest box is the bottleneck. This is <b>self</b> time, so parents
		like Root/_layout barely show — only code that actually burns CPU. Hover for detail.
	</p>
	{#if tree}
		<Treemap hierarchy={tree} />
		<div class="legend">
			{#each legend as c}<span><i style="background:{CATEGORY_COLOR[c]}"></i>{CATEGORY_LABEL[c]}</span
				>{/each}
		</div>
	{/if}
	</section>

	<section class="panel">
	<h2>
		Components <span class="hint" style="font-weight:400">({a.components.length}, click a column to sort)</span>
	</h2>
	<p class="hint">
		<b>self</b> = the component's own code, excluding nested components. <b>total</b> = self plus
		everything it calls. Sort by self to find who burns CPU, by total for the most expensive subtree.{#if hasCounts}
			<b>×N</b> is how many times it rendered.{/if}{#if hasAlloc} <b>alloc</b> is the memory allocated under it (sampled), nested components excluded — sort by it to find who makes the garbage.{/if}
	</p>
	{#if compRows.length}
		<ComponentsTable rows={compRows} busy={a.busy_ms} {hasAlloc} maxTotal={compMaxTotal} {base} {dev} />
	{:else}
		<p class="hint">No component frames in this recording — was any page rendered during the window?</p>
	{/if}
	</section>

	<section class="panel">
	<h2>Hot functions <span class="hint" style="font-weight:400">(click a column to sort)</span></h2>
	<p class="hint">
		Every function on the server, by time spent inside it.{#if hasCounts}
			<b>×N</b> is the exact call count (from V8 coverage).{/if}
	</p>
	{#if !a.sourcemapped}
		<p class="hint warn">
			Locations are bundled chunk positions — no sourcemap resolved. Ship .map files next to the
			server chunks (build with server sourcemaps) and "where" maps back to your source files.
		</p>
	{/if}
	<FunctionsTable rows={fnRows} {hasAlloc} {base} {dev} />
	</section>

	{#if heap.length}
		<section class="panel">
		<h2>Top memory allocators</h2>
		<p class="hint">Sampled heap allocations during the window — who creates the objects (and the GC pressure).</p>
		<table>
			<thead>
				<tr><th>function</th><th>where</th><th></th><th class="num">self</th><th class="num">total</th></tr>
			</thead>
			<tbody>
				{#each heap as h}
					<tr>
						<td class="fn"><b>{h.name}</b></td>
						<td class="file">{h.url}{#if h.line > 0}:{h.line}{/if}</td>
						<td
							><span class="chip" style="background:{CATEGORY_COLOR[h.category]}"
								>{CATEGORY_LABEL[h.category]}</span
							></td
						>
						<td class="num"><b>{fmt_bytes(h.self_bytes)}</b></td>
						<td class="num">{fmt_bytes(h.total_bytes)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		</section>
	{/if}

	{#if spark}
		<section class="panel">
		<h2>Memory over the window</h2>
		<svg class="spark" width={spark.w} height={spark.h} viewBox="0 0 {spark.w} {spark.h}">
			<polyline points={spark.pts} fill="none" stroke="#6ca8e0" stroke-width="1.5" />
			<text x={spark.pad} y="12" fill="#6f8378" font-size="11">{spark.max} MB</text>
			<text x={spark.pad} y={spark.h - 6} fill="#6f8378" font-size="11">{spark.min} MB</text>
		</svg>
		<p class="hint">
			rss {spark.first.rss} → {spark.last.rss} MB · heap {spark.first.heap_used} → {spark.last
				.heap_used} MB
		</p>
		</section>
	{/if}

	{#if measures.length}
		<section class="panel">
		<h2>User timings</h2>
		<p class="hint">Spans emitted with performance.measure() — captured free during the window. Real wall time.</p>
		<table>
			<thead>
				<tr
					><th>name</th><th class="num">count</th><th class="num">total ms</th><th class="num">avg ms</th
					><th class="num">max ms</th></tr
				>
			</thead>
			<tbody>
				{#each measures as m}
					<tr>
						<td class="fn">{m.name}</td>
						<td class="num">{m.count}</td>
						<td class="num"><b>{fmt_ms(m.total_ms)}</b></td>
						<td class="num">{fmt_ms(m.total_ms / m.count)}</td>
						<td class="num">{fmt_ms(m.max_ms)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		</section>
	{/if}

	<section class="panel">
	<h2>Time by file</h2>
	{#if files.length}
		<table>
			<thead><tr><th>file</th><th></th><th class="num">self ms</th><th class="num">% of busy</th></tr></thead>
			<tbody>
				{#each files as f}
					<tr>
						<td class="file">{f.key}</td>
						<td
							><span class="chip" style="background:{CATEGORY_COLOR[f.category]}"
								>{CATEGORY_LABEL[f.category]}</span
							></td
						>
						<td class="num"><b>{fmt_ms(f.self_ms)}</b></td>
						<td class="num">{fmt_pct(f.self_ms, a.busy_ms)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
	</section>

	<section class="panel">
	<h2>Where the CPU went</h2>
	{#each buckets as b}
		<div class="barrow">
			<span class="fn">{b.key}</span>
			<div class="bar" style="width:{Math.max(1, (b.self_ms / maxBucket) * 100)}%;background:{CATEGORY_COLOR[b.category]}"></div>
			<span class="num">{fmt_ms(b.self_ms)} ms</span>
		</div>
	{/each}
	</section>

	{#if meta.trigger === 'page' && meta.runs?.length}
		<section class="panel">
		<h2>Renders of {meta.page ?? ''}</h2>
		<p class="hint">
			Each run is one full server render, median {fmt_ms(runsMedian)} ms.
			{#if meta.redirected_from}Followed a redirect from <code>{meta.redirected_from}</code>.{/if}
			{#if meta.warmup_ms !== undefined}Warm-up render {fmt_ms(meta.warmup_ms)} ms (un-profiled, pays cold module load).{/if}
			{#if meta.run_status !== undefined}Status {meta.run_status}{#if meta.run_bytes !== undefined}, {fmt_bytes(meta.run_bytes)}{/if}.{/if}
		</p>
		<p class="fn">{meta.runs.map((r) => fmt_ms(r) + ' ms').join(' · ')}</p>
		{#if meta.budget_note}<p class="verdict">{meta.budget_note}</p>{/if}
		{#if meta.cold && cold.length}
			<h3 class="sub-h">Cold start <span class="hint">the first render, profiled on its own: {fmt_ms(meta.cold.ms)} ms against {fmt_ms(runsMedian)} ms warm</span></h3>
			<p class="hint">
				What the first render paid over a warm one, per file: module load, compile, first-call caches. On a serverless
				host every cold instance pays this on its first request.
			</p>
			<table>
				<thead><tr><th>file</th><th></th><th class="num">cold ms</th><th class="num">warm ms</th><th class="num">extra</th></tr></thead>
				<tbody>
					{#each cold.slice(0, 20) as r (r.file)}
						<tr>
							<td class="file">{r.file}</td>
							<td><span class="chip" style="background:{CATEGORY_COLOR[r.category]}">{CATEGORY_LABEL[r.category]}</span></td>
							<td class="num">{fmt_ms(r.cold_ms)}</td>
							<td class="num">{fmt_ms(r.warm_ms)}</td>
							<td class="num"><b>+{fmt_ms(r.extra_ms)}</b></td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
		</section>
	{:else if (meta.trigger === 'request' || meta.trigger === 'trap') && meta.request}
		<section class="panel">
		<h2>{meta.trigger === 'trap' ? 'Caught request' : 'Profiled request'}</h2>
		<p class="fn">
			{meta.request.method} {meta.request.path} — {fmt_ms(meta.request.ms)} ms (route {meta.request
				.route ?? '—'})
		</p>
		{#if meta.trigger === 'trap'}
			<p class="hint">
				The background trap kept this window because the request crossed {meta.trap_over ?? 0} ms. Sampled coarsely
				(no per-request context, no stacks on calls), so the timeline is the answer here; the tables are rougher than a
				page profile's.
			</p>
		{/if}
		<p>
			<a class="btn" href="{base}/replay/{meta.id}" title="Render this request again, five times, under the full profiler — same path and query{extras.replay && Object.keys(extras.replay.headers).length ? `, with ${Object.keys(extras.replay.headers).join(', ')}` : ''}">Profile this request in full</a>
			<span class="hint">
				renders <code>{extras.replay?.path ?? meta.request.path}</code> again as a page profile{#if extras.replay && Object.keys(extras.replay.headers).length}
					with the kept headers ({Object.keys(extras.replay.headers).join(', ')}){:else} (no headers kept: name them in <code>trap.replay</code> to carry a tenant or a locale along){/if}
			</span>
		</p>
		</section>
	{/if}

	<section class="panel">
	<h2>Requests during the window</h2>
	<p class="hint">
		Wall-clock time. High total with low net and low CPU = waiting on something we can't see. "inflight"
		= other requests sharing the CPU at the same time.{#if folded}
			The page rendered {meta.runs?.length ?? 0} times, so identical requests are folded into one row: <b>×N</b> is how
			many, the numbers are medians, "max" the slowest of them.{/if}
	</p>
	{#if reqs.length}
		<table>
			<thead>
				<tr
					><th>method</th><th>path</th><th>route</th>{#if tagged.length}<th>tags</th>{/if}<th class="num">status</th><th class="num">inflight</th
					><th class="num">net ms</th><th class="num">cpu ms</th><th class="num">wait ms</th><th class="num"
						>total ms</th
					>{#if folded}<th class="num">max ms</th>{/if}</tr
				>
			</thead>
			<tbody>
				{#each reqs as e}
					<tr>
						<td>{e.method}</td>
						<td class="fn">{e.path}{#if e.count > 1}<span class="hint"> ×{e.count}</span>{/if}{#if e.internal}<span class="warn"> (profiler)</span>{/if}</td>
						<td class="file">{e.route ?? '—'}</td>
						{#if tagged.length}<td class="file">{e.tags || '—'}</td>{/if}
						<td class="num">{e.status || '—'}</td>
						<td class="num">{e.inflight}</td>
						<td class="num">{e.net_count ? fmt_ms(e.net_ms) : '—'}</td>
						<td class="num">{fmt_ms(e.cpu_ms)}</td>
						<td class="num">{fmt_ms(e.wait_ms)}</td>
						<td class="num"><b>{fmt_ms(e.ms)}</b></td>
						{#if folded}<td class="num">{fmt_ms(e.max_ms)}</td>{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="hint">No requests completed inside the window.</p>
	{/if}
	</section>

	<section class="panel">
	<h2>Flame graph</h2>
	<p class="hint">Width = time. Click a bar to zoom, click it again to zoom back out. Orange bars are your components.</p>
	<Flame flame={a.flame} />
	</section>
</Shell>

<style>
	.barrow {
		display: grid;
		grid-template-columns: minmax(160px, 240px) 1fr 90px;
		gap: 10px;
		align-items: center;
		padding: 3px 0;
		font-size: 13px;
	}
	.barrow .num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--text-dim);
	}
	.budget {
		display: flex;
		height: 34px;
		border-radius: var(--r-sm);
		overflow: hidden;
		border: 1px solid var(--line);
		margin: 6px 0;
	}
	.budget > div {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 10.5px;
		color: #06120c;
		font-weight: 600;
		overflow: hidden;
		white-space: nowrap;
		min-width: 0;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 14px;
		margin: 8px 0 0;
		font-size: 11.5px;
		color: var(--text-dim);
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.legend i {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		display: inline-block;
	}
	.spark {
		display: block;
		margin: 6px 0;
	}
	.findings-lead {
		margin: 0 0 12px;
		font-size: 13.5px;
		color: var(--text-dim);
	}
	.fgrid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
		gap: 14px;
		align-items: start;
		margin-bottom: 8px;
	}
	.fgroup {
		background: var(--bg-panel);
		border: 1px solid var(--line);
		border-radius: var(--r-lg);
		padding: 12px 14px;
		min-width: 0;
	}
	.fgroup-h {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 8px;
		font-family: var(--font-body);
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-faint);
	}
	.fgroup-n {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--text-faint);
		background: var(--bg-hover);
		border-radius: 999px;
		padding: 0 6px;
	}
	.finding {
		padding: 8px 0;
		border-top: 1px solid var(--line);
	}
	.finding:first-of-type {
		border-top: 0;
		padding-top: 0;
	}
	.fmsg {
		margin: 0;
		font-size: 13px;
		line-height: 1.45;
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.finding.warn .fmsg {
		color: var(--text);
	}
	.finding.warn {
		border-left: 2px solid var(--warn);
		padding-left: 10px;
		margin-left: -12px;
	}
	.ffix {
		margin: 3px 0 0;
		font-size: 12.5px;
		line-height: 1.4;
		color: var(--text-dim);
	}
	.fshow {
		font-size: 12px;
	}
	.ffile {
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--text-faint);
		margin-left: 6px;
	}
	.scanned {
		overflow-wrap: anywhere;
	}
	.history {
		display: flex;
		gap: 16px;
		align-items: center;
		flex-wrap: wrap;
	}
	.hverdict.warn,
	.lverdict.warn {
		color: var(--warn);
	}
	.lverdict.note {
		color: var(--c-blue);
	}
	.lverdict.good {
		color: var(--good);
	}
	code.props {
		font-size: 11px;
		color: var(--text-dim);
	}
	.sub-h {
		font-size: 14px;
		margin: 14px 0 4px;
	}
	.sub-h .hint {
		font-weight: 400;
		margin-left: 6px;
	}
	tr.by td {
		background: var(--bg-sunken);
		padding: 6px 14px 10px 28px;
		border-bottom: 1px solid var(--line);
	}
	.dimcell {
		color: var(--text-faint);
	}
	.bygrid {
		display: grid;
		grid-template-columns: minmax(120px, max-content) minmax(140px, 1fr) 80px 80px 80px 64px 64px;
		gap: 3px 14px;
		align-items: center;
		font-size: 12px;
		max-width: 760px;
	}
	.bygrid .byh {
		color: var(--text-faint);
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding-bottom: 2px;
		border-bottom: 1px solid var(--line);
	}
	.bygrid .num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--text-dim);
	}
	.bygrid .byv code {
		font-size: 11.5px;
	}
	.bybar {
		height: 6px;
		background: var(--bg-sunken);
		border-radius: 3px;
		overflow: hidden;
	}
	.bybar i {
		display: block;
		height: 100%;
		background: var(--warn);
		border-radius: 3px;
	}
	.dotflag-inline {
		display: inline-block;
		width: 14px;
		height: 14px;
		line-height: 14px;
		text-align: center;
		border-radius: 50%;
		background: var(--warn);
		color: #06120c;
		font-weight: 700;
		font-size: 10px;
	}
</style>
