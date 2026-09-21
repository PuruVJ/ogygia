<script lang="ts">
	/**
	 * ONE CLOCK — the server's render, the HTML arriving, every file the browser fetched, the main
	 * thread's long tasks, each island waking, and the paints, on one time axis from the click. A
	 * `wake:'load'` island: the visit comes from the report (a long-lived host joined the beacon)
	 * or, when the server has none, from this browser's own store (the beacon writes there too —
	 * the merge happens here, never on an instance that may be gone). The critical path is the
	 * highlighted thread through the lanes.
	 */
	import { one_clock, type Visit, type ClockBar } from '../visit.js';
	import { latest_visit } from './store.js';
	import { fmt_ms } from './format.js';

	let {
		server,
		visit = null,
		page,
		names = {}
	}: {
		server: { window_ms: number; phases: { phase: string; label?: string; cpu_ms: number; wait_ms: number }[] } | null;
		visit?: Visit | null;
		page: string;
		names?: Record<string, string>;
	} = $props();

	let v = $state<Visit | null>(visit);
	let source = $state<'server' | 'browser' | 'none'>(visit ? 'server' : 'none');
	let looked = $state(!!visit);
	if (!visit) {
		void latest_visit(page)
			.then((rec) => {
				if (rec?.visit) {
					v = rec.visit as Visit;
					source = 'browser';
				}
			})
			.finally(() => (looked = true));
	}
	const clock = $derived(v ? one_clock(v, server, names) : null);

	const W = 1000;
	const ROW = 16;
	const LEFT = 118;
	const TOP = 22;
	const COLOR: Record<string, string> = {
		'server-hooks': '#8b5cf6',
		'server-load': '#5b8fd6',
		'server-render': '#4d9c6b',
		'server-ogygia': '#c9a227',
		'server-kit': '#6b7280',
		'server-response': '#6b7280',
		ttfb: '#374151',
		download: '#5b8fd6',
		css: '#d9a03d',
		script: '#f0883e',
		font: '#a371f7',
		img: '#3fb950',
		fetch: '#58a6ff',
		other: '#6b7280',
		task: '#ff7b72',
		'island-load': '#79c0ff',
		'island-hydrate': '#2ea043'
	};
	const MARK: Record<string, string> = { fcp: '#8a94a2', lcp: '#d9a03d', dcl: '#8a94a2', load: '#8a94a2', first: '#6ca8e0', mark: '#a371f7' };
	const color = (b: ClockBar) => COLOR[b.kind] ?? (b.kind.startsWith('server-') ? '#4d9c6b' : '#6b7280');
	const x = (t: number) => (clock ? LEFT + (t / clock.end) * (W - LEFT - 8) : LEFT);
	const height = $derived(clock ? TOP + clock.lanes.length * ROW + 40 : 0);
	// time grid: a tick every nice step
	const ticks = $derived.by(() => {
		if (!clock) return [];
		const step = [50, 100, 200, 250, 500, 1000, 2000, 5000, 10000].find((s) => clock.end / s <= 12) ?? 10000;
		const out: number[] = [];
		for (let t = 0; t <= clock.end; t += step) out.push(t);
		return out;
	});
	let tip = $state<{ bar: ClockBar; x: number; y: number } | null>(null);
	let only_critical = $state(false);
	// mark labels on three rows, a label dropped (row −1) when it would sit on one already placed
	const label_rows = $derived.by(() => {
		if (!clock) return [];
		const placed: number[] = [-1e9, -1e9, -1e9];
		return [...clock.marks]
			.sort((a, b) => a.t - b.t)
			.map((m) => {
				const px = x(m.t);
				let row = -1;
				for (let r = 0; r < 3; r++) {
					if (px - placed[r] > 78) {
						placed[r] = px;
						row = r;
						break;
					}
				}
				return { ...m, row };
			});
	});
</script>

{#if clock && v}
	<div class="legend">
		<span class="hint">{source === 'browser' ? 'from this browser’s own visit' : 'from your visit (beacon)'} · {new Date(v.at).toLocaleTimeString()}{v.nav.protocol ? ` · ${v.nav.protocol}` : ''}{v.viewport ? ` · ${v.viewport[0]}×${v.viewport[1]}` : ''}</span>
		<label class="hint"><input type="checkbox" bind:checked={only_critical} /> dim what is not on the critical path</label>
	</div>
	<svg viewBox="0 0 {W} {height}" class="clock" role="img" aria-label="one clock: server, document, network, main thread, islands" onmouseleave={() => (tip = null)}>
		{#each ticks as t (t)}
			<line x1={x(t)} x2={x(t)} y1={TOP - 4} y2={height - 26} class="grid" />
			<text x={x(t)} y={TOP - 8} class="tick">{t} ms</text>
		{/each}
		{#each clock.lanes as lane, i (lane.name)}
			{@const y = TOP + i * ROW}
			<text x={LEFT - 6} y={y + ROW - 4} class="lane-name" text-anchor="end">{lane.name}</text>
			<line x1={LEFT} x2={W - 8} y1={y + ROW} y2={y + ROW} class="lane-sep" />
			{#each lane.bars as b (b.id)}
				<rect
					x={x(b.t0)}
					y={y + 2}
					width={Math.max(x(b.t1) - x(b.t0), 1.5)}
					height={ROW - 4}
					fill={color(b)}
					class="bar"
					class:critical={b.critical}
					class:dim={only_critical && !b.critical}
					class:blocking={b.blocking}
					role="presentation"
					onmouseenter={(e) => (tip = { bar: b, x: e.clientX, y: e.clientY })}
					onmousemove={(e) => (tip = { bar: b, x: e.clientX, y: e.clientY })}
				/>
			{/each}
		{/each}
		{#each label_rows as m, i (m.kind + m.t + i)}
			<line x1={x(m.t)} x2={x(m.t)} y1={TOP - 2} y2={height - 26} stroke={MARK[m.kind] ?? '#9aa4b2'} class="mark" class:soft={m.kind === 'first' || m.kind === 'mark'} />
			{#if m.row >= 0}<text x={x(m.t) + 3} y={height - 16 + m.row * 9} class="mark-label" fill={MARK[m.kind] ?? '#9aa4b2'}>{m.label} {Math.round(m.t)}</text>{/if}
		{/each}
	</svg>
	{#if tip}
		<div class="tip" style="left:{tip.x + 12}px;top:{tip.y + 12}px">
			<b>{tip.bar.label}</b><br />
			{fmt_ms(tip.bar.t0)} → {fmt_ms(tip.bar.t1)} ms ({fmt_ms(tip.bar.t1 - tip.bar.t0)} ms){#if tip.bar.detail}<br />{tip.bar.detail}{/if}{#if tip.bar.critical}<br /><i>on the critical path</i>{/if}
		</div>
	{/if}
	{#if clock.critical.length}
		<ol class="path">
			{#each clock.critical as c (c.id)}
				<li><b>{c.label}</b> <span class="hint">{fmt_ms(c.t0)} → {fmt_ms(c.t1)} ms</span> — {c.why}</li>
			{/each}
			{#if v.paints.lcp !== undefined}<li><b>largest paint</b> <span class="hint">at {fmt_ms(v.paints.lcp)} ms</span>{#if v.paints.lcp_tag} — a <code>{v.paints.lcp_tag}</code>{#if v.paints.lcp_fp && names[v.paints.lcp_fp]} inside <b>{names[v.paints.lcp_fp]}</b>{/if}{/if}</li>{/if}
		</ol>
	{/if}
	{#each clock.notes as n (n)}<p class="hint">{n}</p>{/each}
	<p class="hint">
		The server bar is the profiled render placed so it ends at this visit's first byte; everything else is what this browser measured on the same clock. Islands show module load (light) then hydration (dark). A striped-looking gap before first paint with nothing in the lanes is the browser parsing and laying out.
	</p>
{:else if looked}
	<p class="hint">No visit of <code>{page}</code> from this browser yet. Open the page once while logged in to the profiler, then come back: the beacon records the visit into this browser and (on a long-lived host) into the server.</p>
{:else}
	<p class="hint">Looking for a visit of this page in this browser…</p>
{/if}

<style>
	.legend {
		display: flex;
		gap: 16px;
		align-items: center;
		margin: 4px 0 6px;
	}
	.clock {
		width: 100%;
		height: auto;
		display: block;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: 6px;
	}
	.grid {
		stroke: #1c2129;
		stroke-width: 1;
	}
	.tick {
		fill: var(--text-faint);
		font-size: 9px;
		text-anchor: middle;
	}
	.lane-name {
		fill: var(--text);
		font-size: 10px;
	}
	.lane-sep {
		stroke: var(--bg-raised);
	}
	.bar {
		rx: 2;
		opacity: 0.92;
	}
	.bar.dim {
		opacity: 0.18;
	}
	.bar.critical {
		stroke: #fff;
		stroke-width: 1.2;
		opacity: 1;
	}
	.bar.blocking {
		stroke-dasharray: 2 2;
		stroke: var(--warn);
	}
	.mark {
		stroke-width: 1;
		stroke-dasharray: 3 3;
	}
	.mark.soft {
		opacity: 0.5;
	}
	.mark-label {
		font-size: 9px;
	}
	.tip {
		position: fixed;
		z-index: 20;
		background: var(--bg-raised);
		border: 1px solid var(--line-strong);
		border-radius: 6px;
		padding: 6px 8px;
		font-size: 12px;
		max-width: 360px;
		pointer-events: none;
	}
	.path {
		margin: 8px 0 0;
		padding-left: 20px;
		font-size: 13px;
	}
	.path li {
		margin: 2px 0;
	}
</style>
