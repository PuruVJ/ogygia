<script lang="ts">
	/**
	 * The full SSR profile report. Static sections render server-side; the interactive widgets are
	 * `wake:'load'` islands (treemap, flame graph, sortable tables, export button). Ports report.ts's
	 * render_report — no HTML strings, no minified script blobs.
	 */
	import { derive_findings } from '../report.js';
	import { fmt_ms, fmt_pct, fmt_bytes, label_of, CATEGORY_COLOR, CATEGORY_LABEL } from './format.js';
	import {
		build_treemap,
		treemap_legend,
		budget_segments,
		waiting_rows,
		top_hosts,
		short_url,
		waterfall_rows,
		spark as build_spark,
		net_size
	} from './report-data.js';
	import Shell from './Shell.svelte';
	import ExportButton from './ExportButton.svelte' with { wake: 'load' };
	import Treemap from './Treemap.svelte' with { wake: 'load' };
	import Flame from './Flame.svelte' with { wake: 'load' };
	import ComponentsTable from './ComponentsTable.svelte' with { wake: 'load' };
	import FunctionsTable from './FunctionsTable.svelte' with { wake: 'load' };
	import WaitingTable from './WaitingTable.svelte' with { wake: 'load' };

	import type { ProfilerRoutes } from '../profiler-router.js';
	let { data }: ProfilerRoutes['/report/[id]'] = $props();
	const { a, meta, base, extras, ogpB64 } = $derived(data);

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
	const waitMax = waiting[0]?.ms || 1;
	const spark = build_spark(extras.mem);
	const measures = extras.measures ?? [];
	const heap = extras.heap ?? [];
	const files = a.files.filter((f) => f.category !== 'idle').slice(0, 25);
	const buckets = a.buckets.filter((b) => b.category !== 'idle').slice(0, 15);
	const maxBucket = Math.max(...a.buckets.map((b) => b.self_ms), 1);
	const reqs = meta.requests.slice(0, 60);
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
		<a class="btn" href="{base}/view">Import<span class="sub">.ogp</span></a>
	</div>
	<p class="hint">
		<a href={base}>← dashboard</a> · <a href="{base}/report/{meta.id}.json">JSON</a> (agents) ·
		<a href="{base}/report/{meta.id}/raw">.cpuprofile</a> (DevTools / speedscope) · Export is an
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

	<div class="verdict">
		{#each findings as f, i}{#if i > 0}{' '}{/if}{#if f.severity === 'warn'}<span class="warn"
					>{f.message}</span
				>{:else}{f.message}{/if}{/each}
	</div>

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
			<div class="wf">
				{#each wf as r}
					<div class="wf-row">
						<div class="wf-bar {r.err ? 'err' : ''}" style="left:{r.left}%;width:{r.width}%" title={r.title}>
							{#if r.bodyPct > 5}<span class="body" style="width:{r.bodyPct}%"></span>{/if}
						</div>
						<span
							class="wf-label"
							style={r.rightAnchored
								? `right:calc(${(100 - r.left).toFixed(1)}% + 6px)`
								: `left:calc(${(r.left + r.width).toFixed(1)}% + 6px)`}>{r.label}</span
						>
					</div>
				{/each}
			</div>
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
		<br />
		<p class="hint">Each request — expand for its payload, sizes, and where it came from.</p>
		<div class="reqs">
			{#each netSorted as c}
				{@const sz = net_size(c)}
				<details class="req">
					<summary class="req-sum">
						<span class="rm">{c.method}</span>
						<span class="ru" title={c.url}>{short_url(c.url)}</span>
						<span class="rs {c.error ? 'warn' : ''}">{c.error ? 'ERR' : c.status || '—'}</span>
						<span class="rt">{fmt_ms(c.ms)}{#if c.body_ms}<span class="dim"> +{fmt_ms(c.body_ms)}</span>{/if}</span>
						<span class="rz">{sz != null ? fmt_bytes(sz) : '—'}</span>
					</summary>
					<div class="req-detail">
						<dl>
							<dt>URL</dt>
							<dd class="brk">{c.url}</dd>
							<dt>Response</dt>
							<dd>
								{c.error ? 'error' : c.status || '—'}{#if c.type} · {c.type}{/if}{#if c.encoding} · {c.encoding}{/if}{#if c.error} · {c.error}{/if}
							</dd>
							<dt>Size</dt>
							<dd>
								{#if c.bytes != null}<b>{fmt_bytes(c.bytes)}</b> decoded{/if}{#if c.transfer_bytes != null && c.transfer_bytes !== c.bytes}{#if c.bytes != null}, {/if}{fmt_bytes(c.transfer_bytes)} on the wire{#if c.encoding} <span class="dim">({c.encoding})</span>{/if}{/if}{#if c.bytes == null && c.transfer_bytes == null}—{/if}
							</dd>
							<dt>Timing</dt>
							<dd>{fmt_ms(c.ms)} to headers{#if c.body_ms} · {fmt_ms(c.body_ms)} reading the body{/if}</dd>
							{#if c.route ?? c.path}<dt>From route</dt><dd class="brk">{c.route ?? c.path}</dd>{/if}
							{#if c.caller}<dt>Caller</dt><dd class="brk">{c.caller}</dd>{/if}
							{#if c.req_payload}
								<dt>Request payload{#if c.req_bytes} <span class="dim">({fmt_bytes(c.req_bytes)})</span>{/if}</dt>
								<dd><pre class="payload"><code class="language-json">{c.req_payload}</code></pre></dd>
							{/if}
						</dl>
					</div>
				</details>
			{/each}
		</div>
	{:else}
		<p class="hint">
			No outbound HTTP calls seen in this window. If requests are still slow while the CPU is idle, the
			wait is inside a database/socket driver or a timer.
		</p>
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
		<ComponentsTable rows={compRows} busy={a.busy_ms} {hasAlloc} maxTotal={compMaxTotal} />
	{:else}
		<p class="hint">No component frames in this recording — was any page rendered during the window?</p>
	{/if}

	<h2>Hot functions <span class="hint" style="font-weight:400">(click a column to sort)</span></h2>
	<p class="hint">
		Every function on the server, by time spent inside it.{#if hasCounts}
			<b>×N</b> is the exact call count (from V8 coverage).{/if}
	</p>
	<FunctionsTable rows={fnRows} {hasAlloc} />

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
		= other requests sharing the CPU at the same time.
	</p>
	{#if reqs.length}
		<table>
			<thead>
				<tr
					><th>method</th><th>path</th><th>route</th><th class="num">status</th><th class="num">inflight</th
					><th class="num">net ms</th><th class="num">cpu ms</th><th class="num">wait ms</th><th class="num"
						>total ms</th
					></tr
				>
			</thead>
			<tbody>
				{#each reqs as e}
					<tr>
						<td>{e.method}</td>
						<td class="fn">{e.path}{#if e.internal}<span class="warn"> (profiler)</span>{/if}</td>
						<td class="file">{e.route ?? '—'}</td>
						<td class="num">{e.status || '—'}</td>
						<td class="num">{e.inflight}</td>
						<td class="num">{e.net_count ? fmt_ms(e.net_ms) : '—'}</td>
						<td class="num">{fmt_ms(e.cpu_ms)}</td>
						<td class="num">{fmt_ms(Math.max(0, e.ms - e.cpu_ms))}</td>
						<td class="num"><b>{fmt_ms(e.ms)}</b></td>
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
