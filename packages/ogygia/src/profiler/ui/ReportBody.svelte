<script lang="ts">
	/**
	 * The full SSR profile report. Static sections render server-side; the interactive widgets are
	 * `wake:'load'` islands (treemap, flame graph, sortable tables, export button). Ports report.ts's
	 * render_report — no HTML strings, no minified script blobs.
	 */
	import { derive_findings, span_rows } from '../report.js';
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
	import SeedExplainer from './SeedExplainer.svelte' with { wake: 'load' };
	import Shell from './Shell.svelte';
	import ExportButton from './ExportButton.svelte' with { wake: 'load' };
	import Treemap from './Treemap.svelte' with { wake: 'load' };
	import Flame from './Flame.svelte' with { wake: 'load' };
	import ComponentsTable from './ComponentsTable.svelte' with { wake: 'load' };
	import FunctionsTable from './FunctionsTable.svelte' with { wake: 'load' };
	import WaitingTable from './WaitingTable.svelte' with { wake: 'load' };
	import Waterfall from './Waterfall.svelte' with { wake: 'load' };

	import ShareLink from './ShareLink.svelte' with { wake: 'load' };
	import Timeline from './Timeline.svelte' with { wake: 'load' };
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

	// component memory join + counts
	const allocByName = new Map<string, number>();
	for (const h of extras.heap ?? []) allocByName.set(h.name, (allocByName.get(h.name) ?? 0) + h.self_bytes);
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
		{ value: fmt_ms(a.gc_ms) + ' ms', label: 'garbage collection' },
		{ value: String(meta.requests.length), label: 'requests in window' }
	];
	if (extras.gc) stats.push({ value: fmt_ms(extras.gc.max_ms) + ' ms', label: `GC pause max (${extras.gc.count})` });
	if (meta.loop_delay) stats.push({ value: fmt_ms(meta.loop_delay.p99) + ' ms', label: 'loop delay p99' });
	if (meta.elu_percent !== undefined) stats.push({ value: meta.elu_percent.toFixed(0) + '%', label: 'event loop use' });
	if (meta.rss_mb !== undefined) stats.push({ value: meta.rss_mb + ' MB', label: 'memory (rss)' });
	stats.push({ value: String(a.sample_count), label: 'samples' });

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
	const holes_seen = holes.some((h) => h.requests > 0);
	// page mode: N runs of one page → fold identical requests into one row with the count + medians
	const reqs = request_rows(meta.requests, meta.trigger === 'page').slice(0, 60);
	const folded = meta.trigger === 'page' && reqs.some((r) => r.count > 1);
	const title = `SSR profile — ${label_of(meta)}`;
</script>

<svelte:head><title>{title}</title></svelte:head>

<Shell>
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

	<div class="summary">
		{#each stats as st}<div class="stat"><b>{st.value}</b><span>{st.label}</span></div>{/each}
	</div>

	<h2>Where the time went</h2>
	<p class="hint">
		The whole window, wall-clock. If the biggest segment is "idle / waiting", the server was blocked on
		I/O, not computing — look at Network below. If it's "your code", the treemap and Components table
		show exactly where.
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

	<h2>CPU by self time</h2>
	<p class="hint">
		Every box is real work; the biggest box is the bottleneck. This is <b>self</b> time, so parents
		like Root/_layout barely show — only code that actually burns CPU. Hover for detail.
	</p>
	{#if busy_pct < 25}
		<p class="hint" style="color:#d9a03d">
			This window barely used the CPU ({busy_pct.toFixed(0)}% busy) — the bottleneck is <b>waiting</b>,
			not computing. Look at "Waiting by function" below; the treemap here is just the small slice of
			real CPU work.
		</p>
	{/if}
	{#if tree}
		<Treemap hierarchy={tree} />
		<div class="legend">
			{#each legend as c}<span><i style="background:{CATEGORY_COLOR[c]}"></i>{CATEGORY_LABEL[c]}</span
				>{/each}
		</div>
	{/if}

	<div class="verdict findings">
		{#each findings as f, i (f.code + i)}
			<p class:is-warn={f.severity === 'warn'}>
				{#if f.severity === 'warn'}<span class="warn">{f.message}</span>{:else}{f.message}{/if}
				{#if f.fix}<span class="fix">→ {f.fix}</span>{/if}
				{#if f.anchor}<a class="show" href={row_href(f.anchor)}>show the row ↓</a>{/if}
				{#if f.file && !f.anchor}<span class="file">{f.file}{#if f.line}:{f.line}{/if}</span>{/if}
			</p>
		{/each}
	</div>

	{#if a.timeline}
		<h2>Why this render took {fmt_ms(a.timeline.window_ms)} ms</h2>
		<p class="hint">
			One render, left to right, start to end. Each block is a stretch of time: solid means the CPU was
			running the thing named on it, striped means the server was waiting for a call to come back. The
			numbered steps below are the same blocks in order — the biggest is the one to fix first.
		</p>
		<Timeline t={a.timeline} />
	{/if}

	{#if og}
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

		{#if islands.length}
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
		{/if}

		{#if seed && seed.rows.length}
			<h2>The seed, explained <span class="hint" style="font-weight:400">({fmt_kb(og.seed_bytes)}{#if og.seed_culprit} · devalue because of <code>{og.seed_culprit}</code>{:else if og.seed_json} · json{/if})</span></h2>
			<p class="hint">
				Every top-level <code>page.data</code> key, sized, and why it ships: <span style="color:#e8734a">read</span> by an island's
				client code, <span style="color:#5b8fd6">referenced</span> by an island's props, or <span style="color:#d9a03d">whole</span>
				because an island reads page.data without naming keys. Greyed keys were left out by seed shaping.
			</p>
			<SeedExplainer rows={seed.rows} whole_by={seed.whole_by} total={seed.total} seed_bytes={og.seed_bytes} />
		{/if}

		{#if holes.length}
			<h2>Holes <span class="hint" style="font-weight:400">({holes.length} deferred)</span></h2>
			<p class="hint">
				A hole ships its fallback in the page and renders on the islands endpoint afterwards.{#if holes_seen}
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
							<td class="fn"><code>{h.id}</code></td>
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
		{/if}
	{/if}

	{#if hist && hist_geom && hist_last && hist_prev}
		<h2>History of {meta.page}</h2>
		<div class="history">
			<svg width={hist_geom.w} height={hist_geom.h} viewBox="0 0 {hist_geom.w} {hist_geom.h}">
				<polyline points={hist_geom.poly} fill="none" stroke="#5b8fd6" stroke-width="1.5" />
				{#each hist_geom.pts as [x, y], i (i)}
					<circle cx={x} cy={y} r="3" fill={hist[i].id === meta.id ? '#e8734a' : '#5b8fd6'}>
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
	{/if}

	{#if meta.trigger === 'page' && meta.runs?.length}
		<h2>Renders of {meta.page ?? ''}</h2>
		<p class="hint">
			Each run is one full server render, median {fmt_ms(runsMedian)} ms.
			{#if meta.redirected_from}Followed a redirect from <code>{meta.redirected_from}</code>.{/if}
			{#if meta.warmup_ms !== undefined}Warm-up render {fmt_ms(meta.warmup_ms)} ms (un-profiled, pays cold module load).{/if}
			{#if meta.run_status !== undefined}Status {meta.run_status}{#if meta.run_bytes !== undefined}, {fmt_bytes(meta.run_bytes)}{/if}.{/if}
		</p>
		<p class="fn">{meta.runs.map((r) => fmt_ms(r) + ' ms').join(' · ')}</p>
		{#if meta.budget_note}<p class="verdict">{meta.budget_note}</p>{/if}
	{:else if meta.trigger === 'request' && meta.request}
		<h2>Profiled request</h2>
		<p class="fn">
			{meta.request.method} {meta.request.path} — {fmt_ms(meta.request.ms)} ms (route {meta.request
				.route ?? '—'})
		</p>
	{/if}

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

	{#if spans.length}
		<h2>Spans <span class="hint" style="font-weight:400">(what the app named with <code>span()</code>)</span></h2>
		<p class="hint">
			The waits the profiler cannot see on its own, named in the code. Per render: count and time are
			divided by the {span_runs} render{span_runs === 1 ? '' : 's'} in this recording. A span appears on the
			timeline as "in &lt;name&gt;" wherever a call or a gap sits inside it.
		</p>
		<table>
			<thead>
				<tr
					><th>span</th><th>called from</th><th class="num">per render</th><th class="num">ms / render</th
					><th class="num">p50</th><th class="num">max</th><th>cache</th><th class="num">errors</th></tr
				>
			</thead>
			<tbody>
				{#each spans as s (s.name)}
					<tr>
						<td class="fn"><b>{s.name}</b>{#if s.attr_keys.length}<span class="hint"> · {s.attr_keys.join(', ')}</span>{/if}</td>
						<td class="file">{s.callers[0] ?? '—'}{#if s.callers.length > 1}<span class="hint"> +{s.callers.length - 1}</span>{/if}</td>
						<td class="num">{(s.count / span_runs) % 1 === 0 ? s.count / span_runs : (s.count / span_runs).toFixed(1)}</td>
						<td class="num"><b>{fmt_ms(s.total_ms / span_runs)}</b></td>
						<td class="num">{fmt_ms(s.p50_ms)}</td>
						<td class="num">{fmt_ms(s.max_ms)}</td>
						<td>{#if s.cache}{s.cache.hit} hit · <span class:warn={s.cache.miss > 0}>{s.cache.miss} miss</span>{:else}—{/if}</td>
						<td class="num">{s.errors || (s.open ? `${s.open} open` : '—')}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if waiting.length}
		<h2>Waiting by function <span class="hint" style="font-weight:400">(click a column to sort)</span></h2>
		<p class="hint">
			Where the server WAITED (not computed), attributed to the function that started the I/O. A big
			number here with idle CPU is your bottleneck.
		</p>
		<WaitingTable rows={waiting} maxMs={waitMax} />
	{/if}

	<h2>
		Components <span class="hint" style="font-weight:400">({a.components.length}, click a column to sort)</span>
	</h2>
	<p class="hint">
		<b>self</b> = the component's own code, excluding nested components. <b>total</b> = self plus
		everything it calls. Sort by self to find who burns CPU, by total for the most expensive subtree.{#if hasCounts}
			<b>×N</b> is how many times it rendered.{/if}{#if hasAlloc} "alloc" is memory it allocated.{/if}
	</p>
	{#if compRows.length}
		<ComponentsTable rows={compRows} busy={a.busy_ms} {hasAlloc} maxTotal={compMaxTotal} {base} {dev} />
	{:else}
		<p class="hint">No component frames in this recording — was any page rendered during the window?</p>
	{/if}

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

	{#if heap.length}
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
	{/if}

	{#if spark}
		<h2>Memory over the window</h2>
		<svg class="spark" width={spark.w} height={spark.h} viewBox="0 0 {spark.w} {spark.h}">
			<polyline points={spark.pts} fill="none" stroke="#5b8fd6" stroke-width="1.5" />
			<text x={spark.pad} y="12" fill="#7d8590" font-size="11">{spark.max} MB</text>
			<text x={spark.pad} y={spark.h - 6} fill="#7d8590" font-size="11">{spark.min} MB</text>
		</svg>
		<p class="hint">
			rss {spark.first.rss} → {spark.last.rss} MB · heap {spark.first.heap_used} → {spark.last
				.heap_used} MB
		</p>
	{/if}

	{#if measures.length}
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
	{/if}

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

	<h2>Where the CPU went</h2>
	{#each buckets as b}
		<div class="barrow">
			<span class="fn">{b.key}</span>
			<div class="bar" style="width:{Math.max(1, (b.self_ms / maxBucket) * 100)}%;background:{CATEGORY_COLOR[b.category]}"></div>
			<span class="num">{fmt_ms(b.self_ms)} ms</span>
		</div>
	{/each}

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

	<h2>Flame graph</h2>
	<p class="hint">Width = time. Click a bar to zoom, click it again to zoom back out. Orange bars are your components.</p>
	<Flame flame={a.flame} />
</Shell>

<style>
	.summary {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin: 16px 0;
	}
	.stat {
		background: #171c24;
		border: 1px solid #232a35;
		border-radius: 8px;
		padding: 10px 14px;
		min-width: 108px;
	}
	.stat b {
		display: block;
		font-size: 18px;
		font-variant-numeric: tabular-nums;
	}
	.stat span {
		color: #7d8590;
		font-size: 11.5px;
	}
	.barrow {
		display: grid;
		grid-template-columns: 220px 1fr 90px;
		gap: 10px;
		align-items: center;
		padding: 3px 0;
		font-size: 13px;
	}
	.barrow .num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: #aeb6c2;
	}
	.budget {
		display: flex;
		height: 34px;
		border-radius: 7px;
		overflow: hidden;
		border: 1px solid #232a35;
		margin: 6px 0;
	}
	.budget > div {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 10.5px;
		color: #0d1014;
		font-weight: 600;
		overflow: hidden;
		white-space: nowrap;
		min-width: 0;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 14px;
		margin: 6px 0 0;
		font-size: 11.5px;
		color: #aeb6c2;
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
	.findings p {
		margin: 0;
		padding: 3px 0;
	}
	.findings p + p {
		border-top: 1px solid #232a35;
		margin-top: 4px;
		padding-top: 7px;
	}
	.findings .fix {
		display: block;
		color: #aeb6c2;
		font-size: 13px;
		margin-top: 2px;
	}
	.findings .show {
		font-size: 12px;
		margin-left: 6px;
	}
	.findings .file {
		font-family: ui-monospace, monospace;
		font-size: 12px;
		color: #7d8590;
		margin-left: 6px;
	}
	.history {
		display: flex;
		gap: 16px;
		align-items: center;
		flex-wrap: wrap;
	}
	.good {
		color: #7ee787;
	}
	.hverdict.warn {
		color: #d9a03d;
	}
	.dotflag-inline {
		display: inline-block;
		width: 14px;
		height: 14px;
		line-height: 14px;
		text-align: center;
		border-radius: 50%;
		background: #d9a03d;
		color: #0d1014;
		font-weight: 700;
		font-size: 10px;
	}
</style>
