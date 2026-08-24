<script lang="ts">
	/**
	 * The profiler dashboard (`/__profiler`): live request log, slowest routes, saved reports, and the
	 * "profile a page" form. Static server render — no island; it's a data snapshot. Ports report.ts's
	 * render_dashboard.
	 */
	import type { ReportMeta, RequestEntry, RouteAgg } from '../report.js';
	import { fmt_ms, label_of } from './format.js';
	import Shell from './Shell.svelte';

	let {
		base,
		recent,
		routes,
		reports,
		recording,
		dev,
		rss_mb,
		inflight
	}: {
		base: string;
		recent: RequestEntry[];
		routes: RouteAgg[];
		reports: ReportMeta[];
		recording: boolean;
		dev: boolean;
		rss_mb: number;
		inflight: number;
	} = $props();

	const time = (ms: number) => new Date(ms).toLocaleTimeString();
	let recent_desc = $derived(recent.slice(-40).reverse());
	let top_routes = $derived(routes.slice(0, 20));
</script>

<Shell>
	<h1>
		SSR profiler
		<small>live since server start · {rss_mb} MB rss · {inflight} in flight</small>
	</h1>

	<div class="actions">
		<a class="btn" href="{base}/view">Import<span class="sub">.ogp</span></a>
		<span class="sub">open an encrypted <code>.ogp</code> exported from any run</span>
		{#if !dev}<a class="btn" href="{base}/logout" style="margin-left:auto">Lock</a>{/if}
	</div>

	{#if recording}
		<p class="verdict">
			A profile is running right now. Refresh in a moment — or <a href="{base}/reset">reset</a> if a run
			got stuck.
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

	{#if reports.length}
		<h2>Reports</h2>
		<table>
			<thead>
				<tr><th>report</th><th>when</th><th class="num">window</th><th class="num">requests</th></tr>
			</thead>
			<tbody>
				{#each reports as r (r.id)}
					<tr>
						<td><a href="{base}/report/{r.id}">{label_of(r)}</a></td>
						<td>{time(r.created)}</td>
						<td class="num">{fmt_ms(r.duration_ms)} ms</td>
						<td class="num">{r.requests.length}</td>
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
					><th>when</th><th>method</th><th>path</th><th>route</th><th class="num">status</th><th
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
