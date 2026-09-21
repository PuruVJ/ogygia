<script lang="ts">
	/**
	 * THE WHOLE SITE — two pictures from the sink's rows (sink.ts), or this instance's own ring and
	 * sampler windows: the REQUEST CLOUD (every request as a dot: time across, duration up, colour
	 * by route; drag a range to get the hot functions of the sampler windows inside it) and the
	 * LAYER CAKE (per route, where the time went: CPU, waiting on calls, the rest). A `wake:'load'`
	 * island; `from` is a URL the rows are read from in this browser (the sink you own).
	 */
	import { parse_sink, cloud_points, layer_cake, hot_for_range, type SinkRow, type CloudPoint } from '../sink.js';
	import { fmt_ms } from './format.js';

	let {
		base,
		rows: initial,
		from = null,
		sink = null,
		ephemeral = false
	}: {
		base: string;
		rows: SinkRow[];
		from?: string | null;
		sink?: { url: string; last: { at: number; ok: boolean; rows: number; error?: string } | null; buffered: number } | null;
		ephemeral?: boolean;
	} = $props();

	let rows = $state<SinkRow[]>(initial);
	let loading = $state(!!from);
	let load_error = $state('');
	let from_input = $state(from ?? sink?.url ?? '');
	if (from) {
		void fetch(from, { credentials: 'omit' })
			.then(async (r) => {
				if (!r.ok) throw new Error(`${r.status}`);
				rows = parse_sink(await r.text());
			})
			.catch((e) => (load_error = `Could not read ${from}: ${e instanceof Error ? e.message : e}. The URL must be readable by this browser (CORS).`))
			.finally(() => (loading = false));
	}
	const points = $derived(cloud_points(rows));
	const cake = $derived(layer_cake(rows));
	const traps = $derived(rows.filter((r) => r.k === 'trap'));
	const windows = $derived(rows.filter((r) => r.k === 'win').length);

	// the cloud
	const W = 1000;
	const H = 260;
	const L = 48;
	const B = 22;
	const t0 = $derived(points.length ? points[0].t : 0);
	const t1 = $derived(points.length ? Math.max(points[points.length - 1].t, t0 + 1000) : 1);
	const max_ms = $derived(Math.max(...points.map((p) => p.ms), 10));
	const x = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - 8);
	const y = (ms: number) => H - B - (Math.log10(Math.max(ms, 1)) / Math.log10(max_ms)) * (H - B - 12);
	const routes = $derived([...new Set(points.map((p) => p.route))]);
	const PALETTE = ['#58a6ff', '#3fb950', '#d9a03d', '#a371f7', '#ff7b72', '#79c0ff', '#f0883e', '#56d364', '#ffd166', '#8b949e'];
	const color = (route: string) => PALETTE[routes.indexOf(route) % PALETTE.length];
	const y_ticks = $derived([1, 10, 100, 1000, 10000].filter((v) => v <= max_ms * 1.5));
	let brush = $state<{ a: number; b: number } | null>(null);
	let drag = $state<number | null>(null);
	let svg_el = $state<SVGSVGElement | null>(null);
	const t_at = (clientX: number) => {
		if (!svg_el) return t0;
		const r = svg_el.getBoundingClientRect();
		const px = ((clientX - r.left) / r.width) * W;
		return t0 + ((px - L) / (W - L - 8)) * (t1 - t0);
	};
	const range = $derived(brush ? { lo: Math.min(brush.a, brush.b), hi: Math.max(brush.a, brush.b) } : null);
	const selected = $derived(range ? points.filter((p) => p.t >= range.lo && p.t <= range.hi) : []);
	const hot = $derived(range ? hot_for_range(rows, range.lo, range.hi) : []);
	const p50 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
	let hover = $state<{ p: CloudPoint; x: number; y: number } | null>(null);
	const when = (ms: number) => new Date(ms).toLocaleString();
	const cake_max = $derived(Math.max(...cake.map((c) => c.total), 1));
</script>

<form class="from" onsubmit={(e) => { e.preventDefault(); location.href = `${base}/site${from_input ? `?from=${encodeURIComponent(from_input)}` : ''}`; }}>
	<label>read rows from <input type="url" bind:value={from_input} placeholder="https://…/profiler-rows.ndjson (a sink you serve)" size="60" /></label>
	<button class="btn" type="submit">load</button>
	{#if sink}
		<span class="hint">sink: <code>{sink.url}</code>{#if sink.last} · last post {sink.last.ok ? 'ok' : 'failed'} ({sink.last.rows} rows{sink.last.error ? `: ${sink.last.error}` : ''}){/if}{#if sink.buffered} · {sink.buffered} buffered{/if}</span>
	{/if}
</form>
{#if load_error}<p class="verdict">{load_error}</p>{/if}
{#if loading}
	<p class="hint">Reading rows…</p>
{:else if !points.length}
	<p class="hint">
		No requests to draw yet.{#if ephemeral} This instance is ephemeral: it forgets its requests within seconds. Configure <code>profiler.sink</code> so every instance posts its rows somewhere you serve, then load that URL above.{:else} Requests to the site show up here as they happen; the always-on sampler's windows make the brushed selection answer with hot functions.{/if}
	</p>
{:else}
	<h2>The request cloud <span class="hint" style="font-weight:400">({points.length} requests · {routes.length} routes · {windows} sampler windows{traps.length ? ` · ${traps.length} caught` : ''} · from {when(t0)} to {when(t1)})</span></h2>
	<p class="hint">Every request is a dot: time across, duration up (log scale), colour by route. Drag across a range to select it; the hot functions of the sampler windows inside it appear below.</p>
	<svg
		bind:this={svg_el}
		viewBox="0 0 {W} {H}"
		class="cloud"
		role="img"
		aria-label="every request as a dot"
		onmousedown={(e) => { drag = t_at(e.clientX); brush = { a: drag, b: drag }; }}
		onmousemove={(e) => { if (drag !== null && brush) brush = { a: drag, b: t_at(e.clientX) }; }}
		onmouseup={() => { if (brush && Math.abs(brush.a - brush.b) < (t1 - t0) / 500) brush = null; drag = null; }}
		onmouseleave={() => { drag = null; hover = null; }}
	>
		{#each y_ticks as v (v)}
			<line x1={L} x2={W - 8} y1={y(v)} y2={y(v)} class="grid" />
			<text x={L - 4} y={y(v) + 3} class="tick" text-anchor="end">{v} ms</text>
		{/each}
		{#if brush}
			<rect x={x(Math.min(brush.a, brush.b))} y="6" width={Math.max(x(Math.max(brush.a, brush.b)) - x(Math.min(brush.a, brush.b)), 1)} height={H - B - 6} class="brush" />
		{/if}
		{#each points as p, i (i)}
			<circle cx={x(p.t)} cy={y(p.ms)} r={p.status >= 500 ? 4 : 2.6} fill={color(p.route)} class="dot" class:err={p.status >= 500} role="presentation" onmouseenter={(e) => (hover = { p, x: e.clientX, y: e.clientY })} />
		{/each}
		{#each traps as t, i (i)}
			{#if t.k === 'trap'}<text x={x(t.t)} y="12" class="trap">▼ caught</text>{/if}
		{/each}
		<text x={L} y={H - 6} class="tick">{when(t0)}</text>
		<text x={W - 8} y={H - 6} class="tick" text-anchor="end">{when(t1)}</text>
	</svg>
	{#if hover}
		<div class="tip" style="left:{hover.x + 12}px;top:{hover.y + 12}px"><b>{hover.p.path}</b> · {fmt_ms(hover.p.ms)} ms · {hover.p.status}<br />{fmt_ms(hover.p.cpu)} ms CPU · {fmt_ms(hover.p.wait)} ms waiting · {when(hover.p.t)}</div>
	{/if}
	<div class="legend">
		{#each routes.slice(0, 12) as r (r)}<span><i style="background:{color(r)}"></i>{r}</span>{/each}
	</div>
	{#if brush}
		<div class="sel">
			<p><b>{selected.length} requests selected</b> · p50 {fmt_ms(p50(selected.map((p) => p.ms)))} ms · max {fmt_ms(Math.max(...selected.map((p) => p.ms), 0))} ms · {[...new Set(selected.map((p) => p.route))].slice(0, 5).join(', ')} <button class="link" onclick={() => (brush = null)}>clear</button></p>
			{#if hot.length}
				<table>
					<thead><tr><th>function</th><th>where</th><th class="num">self ms</th><th class="num">windows</th></tr></thead>
					<tbody>
						{#each hot.slice(0, 20) as f (f.name + f.file)}
							<tr><td class="fn"><b>{f.name}</b></td><td class="file">{f.file} <span class="hint">{f.category}</span></td><td class="num">{fmt_ms(f.self_ms)}</td><td class="num">{f.windows}</td></tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<p class="hint">No sampler window overlaps this range. Turn on <code>profiler.sample</code> so the site samples itself; the windows then say what was hot when these requests ran.</p>
			{/if}
		</div>
	{/if}

	<h2>The layer cake <span class="hint" style="font-weight:400">(where the site's time goes, per route)</span></h2>
	<div class="cake">
		{#each cake.slice(0, 25) as c (c.route)}
			<div class="row">
				<div class="name"><b>{c.route}</b> <span class="hint">{c.n} req · p50 {fmt_ms(c.p50)} · p95 {fmt_ms(c.p95)} ms</span></div>
				<div class="bar" title="{fmt_ms(c.cpu)} ms CPU · {fmt_ms(c.wait)} ms waiting · {fmt_ms(c.rest)} ms other">
					<i class="cpu" style="width:{(c.cpu / cake_max) * 100}%"></i><i class="wait" style="width:{(c.wait / cake_max) * 100}%"></i><i class="rest" style="width:{(c.rest / cake_max) * 100}%"></i>
				</div>
				<div class="tot">{fmt_ms(c.total)} ms</div>
			</div>
		{/each}
	</div>
	<div class="legend"><span><i class="cpu"></i>CPU</span><span><i class="wait"></i>waiting on calls</span><span><i class="rest"></i>the rest (event loop, other requests, the platform)</span></div>
	<p class="hint">Bars are the sum over the route's requests, so a route that is slow AND busy sits on top. A route mostly “waiting” wants parallel calls or a cache; one mostly CPU wants a profile of one of its pages; a wide “rest” means the instance was doing something else at the time.</p>
{/if}

<style>
	.from {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}
	.cloud {
		width: 100%;
		height: auto;
		display: block;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: 6px;
		cursor: crosshair;
		user-select: none;
	}
	.grid {
		stroke: #1c2129;
	}
	.tick {
		fill: #6b7280;
		font-size: 9px;
	}
	.dot {
		opacity: 0.85;
	}
	.dot.err {
		stroke: var(--bad);
		stroke-width: 1.5;
	}
	.brush {
		fill: rgba(88, 166, 255, 0.15);
		stroke: var(--c-blue);
	}
	.trap {
		fill: var(--bad);
		font-size: 9px;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 14px;
		font-size: 12px;
		margin: 6px 0;
	}
	.legend i,
	.bar i {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 2px;
		margin-right: 4px;
		vertical-align: middle;
	}
	.sel {
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 8px 12px;
		margin: 8px 0;
	}
	.link {
		background: none;
		border: 0;
		color: inherit;
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
	}
	.cake .row {
		display: grid;
		grid-template-columns: 300px 1fr 80px;
		gap: 10px;
		align-items: center;
		margin: 4px 0;
		font-size: 13px;
	}
	.cake .bar {
		height: 14px;
		background: var(--bg-sunken);
		border-radius: 3px;
		overflow: hidden;
		display: flex;
	}
	.cake .bar i {
		height: 100%;
		border-radius: 0;
		margin: 0;
		display: block;
	}
	.cpu {
		background: var(--c-orange);
	}
	.wait {
		background: var(--c-blue);
	}
	.rest {
		background: #374151;
	}
	.tot {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.tip {
		position: fixed;
		z-index: 20;
		background: var(--bg-raised);
		border: 1px solid var(--line-strong);
		border-radius: 6px;
		padding: 6px 8px;
		font-size: 12px;
		pointer-events: none;
	}
</style>
