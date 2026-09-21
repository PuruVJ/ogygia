<script lang="ts">
	/**
	 * The profiler dashboard (`/__profiler`): live request log, slowest routes, saved reports, and the
	 * "profile a page" form. Static server render — no island; it's a data snapshot. Ports report.ts's
	 * render_dashboard.
	 */
	import { fmt_ms, label_of } from './format.js';
	import Shell from './Shell.svelte';
	import LocalReports from './LocalReports.svelte' with { wake: 'load' };
	import type { ProfilerRoutes } from '../profiler-router.js';
	let { data }: ProfilerRoutes['/'] = $props();
	const { base, recent, routes, reports, recording, dev, rss_mb, inflight, history, by, tag_keys, trap, sampled, background_note } = $derived(data);
	const sampled_max = $derived(Math.max(...(sampled?.functions.map((f) => f.self_ms) ?? [0]), 0.01));

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

<Shell {base}>
	<div class="head">
		<h1>
			SSR profiler
			<small>live since server start</small>
		</h1>
		<div class="actions">
			<a class="btn" href="{base}/site" title="Every request as a dot, and where the site's time goes per route — from this instance, or from a sink over days">The whole site</a>
			<a class="btn" href="{base}/view">Import<span class="sub">.ogp</span></a>
			<a class="btn danger" class:recording href="{base}/reset" title="Stop any running or stuck recording and clear the profiler's state.">Reset</a>
			{#if !dev}<a class="btn" href="{base}/logout">Lock</a>{/if}
		</div>
	</div>

	<div class="summary">
		<div class="stat"><b>{rss_mb} MB</b><span>memory (rss)</span></div>
		<div class="stat"><b>{inflight}</b><span>requests in flight</span></div>
		<div class="stat"><b>{reports.length}</b><span>reports held</span></div>
		<div class="stat"><b>{routes.length}</b><span>routes seen</span></div>
		{#if tracked.length}<div class="stat"><b>{tracked.length}</b><span>pages tracked over time</span></div>{/if}
	</div>

	{#if recording}
		<p class="verdict">
			A profile is running right now. Refresh in a moment — or hit <b>Reset</b> above if a run got stuck.
		</p>
	{/if}

	<div class="grid">
		<section class="panel">
			<h2>Profile a page</h2>
			<p class="hint">
				A path on this site. It renders through your real server a few times and shows exactly where the
				time went — components, functions, allocations, and outbound calls.
			</p>
			<form class="inline" action="{base}/run" method="get">
				<label>path <input name="p" placeholder="/some/slow/page" size="24" /></label>
				<label>renders <input name="runs" value="5" size="3" /></label>
				<label class="ogp-opt" title="Recommended on serverless: the report can't be kept in memory across invocations. Download the encrypted .ogp, then open it via Import.">
					<input type="checkbox" name="format" value="ogp" /> <code>.ogp</code>
				</label>
				<button class="primary">Profile</button>
			</form>
			<p class="hint">On a <b>serverless</b> host, tick <code>.ogp</code> — the profile streams back as an encrypted file, then <a href="{base}/view">open it here</a>. Or profile one live request with the <code>x-profile: &lt;secret&gt;</code> header.</p>
		</section>
		<section class="panel">
			<h2>Getting started</h2>
			<p class="hint">
				Type a path and hit <b>Profile</b> to record a page. Every recording shows up in the sidebar and,
				with a store configured, is shared across instances. Watch a route's median over time under
				<b>Pages over time</b>; a jump is a regression you can open a compare on.
			</p>
			<p class="hint">
				The <b>whole site</b> view plots every request and where each route spends its time. <b>Reset</b>
				clears a stuck recording if the site drags after profiling.
			</p>
		</section>
	</div>

	<LocalReports {base} server_ids={reports.map((r) => r.id)} />

	{#if trap || sampled || background_note}
		<h2>In the background</h2>
		{#if background_note}<p class="verdict">{background_note}</p>{/if}
		{#if trap}
			<p class="hint">
				<b>Catch the slow one:</b> {trap.armed ? 'armed' : 'done'} — a coarse sampler runs in {Math.round(trap.window_ms / 1000)} s windows and keeps
				the window when a request crosses <b>{trap.over} ms</b>. Caught {trap.caught} of {trap.keep}.{#if trap.caught}
					The reports are in the list below, labelled "caught".{/if}
			</p>
		{/if}
		{#if sampled}
			<p class="hint">
				<b>Always-on sampling:</b> one {Math.round(sampled.window_ms / 1000 * 10) / 10} s window every {sampled.every_s} s, folded into the table
				below — {sampled.windows} window{sampled.windows === 1 ? '' : 's'} so far{#if sampled.since}, since {time(sampled.since)}{/if},
				{fmt_ms(sampled.busy_ms)} ms busy of {fmt_ms(sampled.sampled_ms)} ms sampled. Accuracy from volume: a function that is hot here is
				hot in real traffic, whatever one recording says.
			</p>
			{#if sampled.functions.length}
				<table>
					<thead><tr><th>function</th><th>where</th><th class="num">self ms (summed)</th><th class="num">in windows</th></tr></thead>
					<tbody>
						{#each sampled.functions.slice(0, 25) as f (f.key)}
							<tr>
								<td class="fn"><b>{f.name}</b>{#if f.pkg}<span class="hint"> · {f.pkg}</span>{/if}</td>
								<td class="file">{f.url}{#if f.line > 0}:{f.line}{/if}</td>
								<td class="num bar-cell"><div class="bar" style="width:{(f.self_ms / sampled_max) * 100}%"></div><b>{fmt_ms(f.self_ms)}</b></td>
								<td class="num">{f.windows}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<p class="hint">No window sampled yet.</p>
			{/if}
		{/if}
	{/if}

	<div class="grid">
	{#if tracked.length}
		<section class="panel wide">
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
								><polyline points={g.poly} fill="none" stroke="var(--c-blue)" stroke-width="1.5" /></svg
							></td
						>
						<td class="num"><a href="{base}/report/{last.id}">{fmt_ms(last.median)} ms</a></td>
						<td class="num" style="color:{d > 5 ? 'var(--bad)' : d < -5 ? 'var(--good)' : 'inherit'}"
							>{d > 0 ? '+' : ''}{d.toFixed(0)}%</td
						>
						<td><a href="{base}/compare/{before.id}/{last.id}">compare</a></td>
					</tr>
				{/each}
			</tbody>
		</table>
		</section>
	{/if}

	{#if reports.length}
		<section class="panel wide">
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
		</section>
	{/if}

	<section class="panel wide">
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
	</section>

	<section class="panel wide">
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
	</section>
	</div>
</Shell>

<style>
	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}
	.head .actions {
		margin-top: 4px;
	}
	.ogp-opt {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12.5px;
		color: var(--text-dim);
	}
	.bar-cell {
		position: relative;
		min-width: 120px;
	}
	.bar-cell .bar {
		position: absolute;
		left: 4px;
		right: 4px;
		bottom: 3px;
		height: 3px;
		max-width: calc(100% - 8px);
		background: var(--accent);
		border-radius: 2px;
		opacity: 0.7;
	}
</style>
