<script lang="ts">
	/**
	 * The profiler dashboard (`/__profiler`): live request log, slowest routes, saved reports, and the
	 * "profile a page" form. Static server render — no island; it's a data snapshot. Ports report.ts's
	 * render_dashboard.
	 */
	import { fmt_ms, label_of } from './format.js';
	import Shell from './Shell.svelte';
	import type { ProfilerRoutes } from '../profiler-router.js';
	let { data }: ProfilerRoutes['/'] = $props();
	const { base, recent, routes, reports, recording, dev, rss_mb, inflight, history, by, tag_keys } = $derived(data);

	const time = (ms: number) => new Date(ms).toLocaleTimeString();
	let recent_desc = $derived(recent.slice(-40).reverse());
	let top_routes = $derived(routes.slice(0, 20));
	// the previous page-mode report of the same page, for each report — the "compare" link
	const prev_of = $derived.by(() => {
		const m = new Map<string, string>();
		for (const h of history) for (let i = 1; i < h.points.length; i++) m.set(h.points[i].id, h.points[i - 1].id);
		return m;
	});
	const tracked = $derived(history.filter((h) => h.points.length >= 2));
	const spark = (pts: { median: number }[]) => {
		const w = 160,
			h = 28,
			pad = 3;
		const max = Math.max(...pts.map((p) => p.median), 1);
		const step = pts.length > 1 ? (w - 2 * pad) / (pts.length - 1) : 0;
		return {
			w,
			h,
			poly: pts.map((p, i) => `${pad + i * step},${h - pad - (p.median / max) * (h - 2 * pad)}`).join(' ')
		};
	};
	const delta_pct = (pts: { median: number }[]) => {
		const a = pts[pts.length - 2].median;
		const b = pts[pts.length - 1].median;
		return a > 0 ? ((b - a) / a) * 100 : 0;
	};
</script>

<Shell>
	<h1>
		SSR profiler
		<small>live since server start · {rss_mb} MB rss · {inflight} in flight</small>
	</h1>

	<div class="actions">
		<a class="btn" href="{base}/view">Import<span class="sub">.ogp</span></a>
		<span class="sub">open an encrypted <code>.ogp</code> exported from any run</span>
		<a
			class="btn danger"
			class:recording
			href="{base}/reset"
			style="margin-left:auto"
			title="Stop any running or stuck recording and clear the profiler's state. Use this if the site feels slow after profiling — a recording holds a site-wide timing context open until it ends."
			>Reset</a
		>
		{#if !dev}<a class="btn" href="{base}/logout">Lock</a>{/if}
	</div>

	{#if recording}
		<p class="verdict">
			A profile is running right now. Refresh in a moment — or hit <b>Reset</b> above if a run got stuck.
		</p>
	{/if}

	<h2>Profile a page</h2>
	<p class="hint">
		Enter a path on this site. It renders through your real server a few times and shows exactly where
		the time went — components, functions, allocations, and outbound calls.
	</p>
	<form class="inline" action="{base}/run" method="get">
		<label>path <input name="p" placeholder="/some/slow/page" size="28" /></label>
		<label>renders <input name="runs" value="5" size="3" /></label>
		<label
			title="Recommended on serverless (Amplify/Vercel/Netlify): the report can't be kept in memory across invocations, and a huge report can crash the browser. Download the encrypted .ogp, then open it via Import."
		>
			<input type="checkbox" name="format" value="ogp" /> download <code>.ogp</code>
		</label>
		<button>Profile</button>
	</form>
	<p class="hint">
		On a <b>serverless</b> host, tick <b>download .ogp</b> — the profile streams back as an encrypted file
		(the report can't be kept in memory, and a full report can be too heavy for the browser), then
		<a href="{base}/view">open it here</a>. Or profile one live request with the
		<code>x-profile: &lt;secret&gt;</code> header.
	</p>

	{#if tracked.length}
		<h2>Pages over time</h2>
		<p class="hint">
			Every page profiled more than once: its median render per run, oldest to newest. A jump is a
			regression — open the compare to see which component or function moved.
		</p>
		<table>
			<thead>
				<tr><th>page</th><th>runs</th><th class="num">latest</th><th class="num">vs previous</th><th></th></tr>
			</thead>
			<tbody>
				{#each tracked as h (h.page)}
					{@const g = spark(h.points)}
					{@const d = delta_pct(h.points)}
					{@const last = h.points[h.points.length - 1]}
					{@const before = h.points[h.points.length - 2]}
					<tr>
						<td class="fn">{h.page}</td>
						<td
							><svg width={g.w} height={g.h} viewBox="0 0 {g.w} {g.h}"
								><polyline points={g.poly} fill="none" stroke="#5b8fd6" stroke-width="1.5" /></svg
							></td
						>
						<td class="num"><a href="{base}/report/{last.id}">{fmt_ms(last.median)} ms</a></td>
						<td class="num" style="color:{d > 5 ? '#ff7b72' : d < -5 ? '#7ee787' : 'inherit'}"
							>{d > 0 ? '+' : ''}{d.toFixed(0)}%</td
						>
						<td><a href="{base}/compare/{before.id}/{last.id}">compare</a></td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if reports.length}
		<h2>Reports</h2>
		<table>
			<thead>
				<tr><th>report</th><th>when</th><th class="num">window</th><th class="num">requests</th><th></th></tr>
			</thead>
			<tbody>
				{#each reports as r (r.id)}
					<tr>
						<td><a href="{base}/report/{r.id}">{label_of(r)}</a></td>
						<td>{time(r.created)}</td>
						<td class="num">{fmt_ms(r.duration_ms)} ms</td>
						<td class="num">{r.requests.length}</td>
						<td
							>{#if prev_of.has(r.id)}<a href="{base}/compare/{prev_of.get(r.id)}/{r.id}"
									>compare with previous</a
								>{/if}</td
						>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	<h2>Slowest routes</h2>
	<p class="hint">
		Wall-clock per request since server start. p95 is the slow tail. "net p50" is time inside outbound
		calls — when it tracks the total, the route is waiting on other services, not computing.
	</p>
	{#if tag_keys.length}
		<p class="hint">
			Split by tag (<code>tag()</code> from ogygia/profiler):
			<a href={base} class:active={!by}>none</a>
			{#each tag_keys as k (k)}· <a href="{base}?by={encodeURIComponent(k)}" class:active={by === k}>{k}</a>{/each}
		</p>
	{/if}
	{#if top_routes.length}
		<table>
			<thead>
				<tr
					><th>route</th><th class="num">hits</th><th class="num">p50 ms</th><th class="num">p95 ms</th
					><th class="num">max ms</th><th class="num">net p50</th></tr
				>
			</thead>
			<tbody>
				{#each top_routes as r (r.route)}
					<tr>
						<td class="fn">{r.route}</td>
						<td class="num">{r.count}</td>
						<td class="num">{fmt_ms(r.p50)}</td>
						<td class="num">{fmt_ms(r.p95)}</td>
						<td class="num">{fmt_ms(r.max)}</td>
						<td class="num">{fmt_ms(r.net_p50)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="hint">No requests seen yet — load some pages, then refresh.</p>
	{/if}

	<h2>Recent requests</h2>
	{#if recent_desc.length}
		<table>
			<thead>
				<tr
					><th>when</th><th>method</th><th>path</th><th>route</th>{#if tag_keys.length}<th>tags</th>{/if}<th class="num">status</th><th
						class="num">net ms</th
					><th class="num">total ms</th></tr
				>
			</thead>
			<tbody>
				{#each recent_desc as e (e.ts + e.path)}
					<tr>
						<td>{time(e.ts)}</td>
						<td>{e.method}</td>
						<td class="fn">{e.path}{#if e.internal}<span class="warn"> (profiler)</span>{/if}</td>
						<td class="file">{e.route ?? '—'}</td>
						{#if tag_keys.length}<td class="file">{e.tags ? Object.entries(e.tags).map(([k, v]) => `${k}=${v}`).join(' ') : '—'}</td>{/if}
						<td class="num">{e.status || '—'}</td>
						<td class="num"
							>{#if e.net_count}{fmt_ms(e.net_ms)} <span class="hint">({e.net_count})</span
							>{:else}—{/if}</td
						>
						<td class="num"><b>{fmt_ms(e.ms)}</b></td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="hint">Nothing yet.</p>
	{/if}
</Shell>
