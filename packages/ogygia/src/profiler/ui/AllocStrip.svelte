<script lang="ts">
	/**
	 * WHEN THE HEAP GREW — the used heap sampled finely over the capture (alloc.ts), the GC
	 * pauses as drops, the one window the report explains lit, and the fastest-growing
	 * stretches listed with what the CPU was running then. Static: nothing to click.
	 */
	import type { AllocTimeline } from '../alloc.js';
	import { fmt_ms, CATEGORY_COLOR } from './format.js';

	let { alloc, gc = [] }: { alloc: AllocTimeline; gc?: { t: number; ms: number; kind: string }[] } = $props();

	const W = 960;
	const H = 90;
	const s = alloc.samples;
	const t_max = Math.max(s[s.length - 1]?.t ?? 1, 1);
	const mbs = s.map((x) => x.mb);
	const lo = Math.min(...mbs);
	const hi = Math.max(...mbs);
	const range = Math.max(hi - lo, 1);
	const x_of = (t: number) => (t / t_max) * W;
	const y_of = (mb: number) => H - 6 - ((mb - lo) / range) * (H - 14);
	const path = s.map((p, i) => `${i ? 'L' : 'M'}${x_of(p.t).toFixed(1)},${y_of(p.mb).toFixed(1)}`).join(' ');
	const win = alloc.window ?? null;
	const color = (c: string) => CATEGORY_COLOR[c as keyof typeof CATEGORY_COLOR] ?? '#6b7280';
	const on_window = (t: number) => (win ? t >= win.offset_ms && t <= win.offset_ms + win.ms : false);
</script>

<svg viewBox="0 0 {W} {H + 16}" class="chart" role="img" aria-label="used heap over the recording">
	{#if win}
		<rect x={x_of(win.offset_ms)} y="0" width={Math.max(1, x_of(win.offset_ms + win.ms) - x_of(win.offset_ms))} height={H} fill="#6fe3b0" opacity="0.1" />
	{/if}
	{#each gc as g, i (i)}
		<rect x={x_of(g.t)} y="0" width={Math.max(1, x_of(g.t + g.ms) - x_of(g.t))} height={H} fill={g.kind === 'major' ? '#f85149' : '#d29922'} opacity="0.55">
			<title>{g.kind} GC, {fmt_ms(g.ms)} ms at {fmt_ms(g.t)} ms</title>
		</rect>
	{/each}
	{#each alloc.bursts as b, i (i)}
		<rect x={x_of(b.t0)} y={H - 4} width={Math.max(2, x_of(b.t1) - x_of(b.t0))} height="4" fill="#f0883e">
			<title>+{b.mb} MB in {fmt_ms(b.t1 - b.t0)} ms ({b.rate} MB/s){b.running[0] ? ` while ${b.running[0].label} ran` : ''}</title>
		</rect>
	{/each}
	<path d={path} fill="none" stroke="#6ca8e0" stroke-width="1.5" />
	<text x="2" y="11" font-size="10" fill="#6f8378">{Math.round(hi)} MB</text>
	<text x="2" y={H - 8} font-size="10" fill="#6f8378">{Math.round(lo)} MB</text>
	<text x={W - 2} y={H + 12} font-size="10" fill="#6f8378" text-anchor="end">{fmt_ms(t_max)} ms</text>
	{#if win}
		<text x={x_of(win.offset_ms) + 3} y={H + 12} font-size="10" fill="#6fe3b0">the render this report explains</text>
	{/if}
</svg>
<p class="hint">
	The heap grew <b>{alloc.grown_mb} MB</b> over the intervals that grew, sampled every ~{alloc.period_ms} ms when the loop yielded
	(the longest stretch without a sample, a synchronous run, was {fmt_ms(alloc.longest_gap_ms)} ms). Orange marks under the line
	are the bursts below; red and yellow bars are the collections — a burst with one inside allocated more than the line shows.
</p>
{#if alloc.bursts.length}
	<table>
		<thead><tr><th>when</th><th class="num">grew</th><th class="num">rate</th><th>what was running</th></tr></thead>
		<tbody>
			{#each alloc.bursts as b, i (i)}
				<tr>
					<td class="num">{fmt_ms(b.t0)}–{fmt_ms(b.t1)} ms{#if on_window(b.t0)}<span class="hint" title="inside the render this report explains"> ●</span>{/if}</td>
					<td class="num"><b>+{b.mb} MB</b>{#if b.gc}<span class="hint" title="a collection fell inside: the allocation was more than the growth"> +GC</span>{/if}</td>
					<td class="num">{b.rate} MB/s</td>
					<td class="fn">
						{#each b.running as r, k (k)}
							<span class="who"><i style="background:{color(r.category)}"></i>{r.label} <span class="hint">{Math.round(r.share * 100)}%{#if r.file} · {r.file}{/if}</span></span>
						{:else}
							<span class="hint">nothing on the CPU (the growth came from a native side or between samples)</span>
						{/each}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

<style>
	.chart {
		width: 100%;
		height: auto;
		display: block;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
	}
	.who {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-right: 12px;
	}
	.who i {
		width: 8px;
		height: 8px;
		border-radius: 2px;
		display: inline-block;
	}
</style>
