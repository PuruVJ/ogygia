<script lang="ts">
	/**
	 * THE SCRUBBER — the render's CPU as a density strip over the stack index (analyze.ts
	 * `StackIndex`, queried by stacks.ts). Drag across it to ask "what ran between here and here":
	 * the self and inclusive tables answer for that range only. Move the cursor to ask "what was
	 * the stack at this instant". Every other table in the report is an aggregate over the whole
	 * window; this is the same data, sliced where the eye lands. A `wake:'load'` island.
	 */
	import type { StackIndex } from '../analyze.js';
	import { density, range_hot, stack_at, type RangeSummary, type StackAt } from '../stacks.js';
	import { fmt_ms, CATEGORY_COLOR } from './format.js';

	let { stacks, marks = [] }: { stacks: StackIndex; marks?: { t: number; label: string }[] } = $props();

	const W = 960;
	const H = 72;
	const BINS = 240;
	const bins = density(stacks, BINS);
	const comp_bins = density(stacks, BINS, 'component');
	const bin_ms = stacks.window_ms / BINS;
	const max_bin = Math.max(...bins, bin_ms, 0.001);
	const x_of = (t: number) => (t / (stacks.window_ms || 1)) * W;
	const t_of = (x: number) => Math.max(0, Math.min(stacks.window_ms, (x / W) * stacks.window_ms));

	let sel = $state<{ t0: number; t1: number } | null>(null);
	let cursor = $state<number | null>(null);
	let drag = $state<{ from: number; moved: boolean } | null>(null);
	let view = $state<'self' | 'total' | 'components'>('self');

	const range = $derived<RangeSummary>(sel ? range_hot(stacks, sel.t0, sel.t1) : range_hot(stacks, 0, stacks.window_ms));
	const at = $derived<StackAt | null>(cursor === null ? null : stack_at(stacks, cursor));
	const rows = $derived(view === 'self' ? range.self : view === 'total' ? range.total : range.components);
	const row_max = $derived(Math.max(...rows.map((r) => (view === 'self' ? r.self_ms : r.total_ms)), 0.001));

	function svg_x(e: PointerEvent, el: SVGSVGElement): number {
		const r = el.getBoundingClientRect();
		return ((e.clientX - r.left) / r.width) * W;
	}
	function down(e: PointerEvent) {
		const el = e.currentTarget as SVGSVGElement;
		el.setPointerCapture(e.pointerId);
		drag = { from: t_of(svg_x(e, el)), moved: false };
	}
	function move(e: PointerEvent) {
		const el = e.currentTarget as SVGSVGElement;
		const t = t_of(svg_x(e, el));
		cursor = t;
		if (drag) {
			const a = Math.min(drag.from, t);
			const b = Math.max(drag.from, t);
			if (b - a > stacks.window_ms * 0.002) {
				drag.moved = true;
				sel = { t0: a, t1: b };
			}
		}
	}
	function up() {
		if (drag && !drag.moved) sel = null;
		drag = null;
	}
	function leave() {
		cursor = null;
		if (drag) up();
	}
	const category_of = (r: { category: string }) => CATEGORY_COLOR[r.category as keyof typeof CATEGORY_COLOR] ?? '#6b7280';
</script>

<div class="scrub">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<svg viewBox="0 0 {W} {H + 18}" class="strip" onpointerdown={down} onpointermove={move} onpointerup={up} onpointerleave={leave} role="img" aria-label="CPU density over the render; drag to select a range">
		{#each bins as b, i (i)}
			<rect x={(i / BINS) * W} y={H - (b / max_bin) * H} width={W / BINS + 0.3} height={(b / max_bin) * H} fill="#6f8378" opacity="0.5" />
			<rect x={(i / BINS) * W} y={H - (comp_bins[i] / max_bin) * H} width={W / BINS + 0.3} height={(comp_bins[i] / max_bin) * H} fill="#6fe3b0" opacity="0.85" />
		{/each}
		{#each marks as m, k (k)}
			<line x1={x_of(m.t)} x2={x_of(m.t)} y1="0" y2={H} stroke="#d29922" stroke-dasharray="3 3">
				<title>{m.label} at {fmt_ms(m.t)} ms</title>
			</line>
			{#if k < 3}<text x={x_of(m.t) + 3} y={H + 13} font-size="10" fill="#d29922">{m.label}</text>{/if}
		{/each}
		{#if sel}
			<rect x={x_of(sel.t0)} y="0" width={Math.max(1, x_of(sel.t1) - x_of(sel.t0))} height={H} fill="#6fe3b0" opacity="0.16" stroke="#6fe3b0" />
		{/if}
		{#if cursor !== null}
			<line x1={x_of(cursor)} x2={x_of(cursor)} y1="0" y2={H} stroke="#e6eee9" stroke-width="1" />
		{/if}
		<text x="2" y={H + 13} font-size="10" fill="#6f8378">0</text>
		<text x={W - 2} y={H + 13} font-size="10" fill="#6f8378" text-anchor="end">{fmt_ms(stacks.window_ms)} ms</text>
	</svg>
	<div class="bar">
		<span class="hint">
			{#if sel}
				<b>{fmt_ms(sel.t0)}–{fmt_ms(sel.t1)} ms</b> · {fmt_ms(range.cpu_ms)} ms CPU, {fmt_ms(range.idle_ms)} ms idle
				<button class="lnk" onclick={() => (sel = null)}>whole render</button>
			{:else}
				whole render · {fmt_ms(range.cpu_ms)} ms CPU · drag on the strip to slice it
			{/if}
			· grey is any CPU, green is a component's
		</span>
		<span class="views">
			<button class:on={view === 'self'} onclick={() => (view = 'self')}>self</button>
			<button class:on={view === 'total'} onclick={() => (view = 'total')}>owners</button>
			<button class:on={view === 'components'} onclick={() => (view = 'components')}>components</button>
		</span>
	</div>
	<div class="cols">
		<table>
			<thead><tr><th>{view === 'total' ? 'on the stack' : view === 'components' ? 'component' : 'running'}</th><th class="num">{view === 'self' ? 'self ms' : 'total ms'}</th><th class="num">of range</th></tr></thead>
			<tbody>
				{#each rows.slice(0, 16) as r, k (k)}
					<tr>
						<td class="fn"><i class="dot" style="background:{category_of(r)}"></i>{r.name}{#if r.file}<span class="hint"> {r.file}</span>{/if}</td>
						<td class="num">{fmt_ms(view === 'self' ? r.self_ms : r.total_ms)}</td>
						<td class="num"><div class="mini"><div style="width:{(((view === 'self' ? r.self_ms : r.total_ms) / row_max) * 100).toFixed(0)}%;background:{category_of(r)}"></div></div>{range.cpu_ms > 0 ? (((view === 'self' ? r.self_ms : r.total_ms) / range.cpu_ms) * 100).toFixed(0) : 0}%</td>
					</tr>
				{:else}
					<tr><td colspan="3" class="hint">no CPU sample in this range</td></tr>
				{/each}
			</tbody>
		</table>
		<div class="stack">
			<div class="hint">
				{#if at}
					stack at <b>{fmt_ms(at.t)} ms</b> ({fmt_ms(at.ms)} ms sample), outermost first
				{:else}
					move over the strip for the stack at that instant
				{/if}
			</div>
			{#if at}
				<ol>
					{#each at.frames as f, i (i)}
						<li><i class="dot" style="background:{category_of(f)}"></i>{f.name}{#if f.file}<span class="hint"> {f.file}</span>{/if}</li>
					{:else}
						<li class="hint">idle</li>
					{/each}
				</ol>
			{/if}
		</div>
	</div>
</div>

<style>
	.scrub {
		margin: 6px 0 10px;
	}
	.strip {
		width: 100%;
		height: auto;
		display: block;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		cursor: crosshair;
		touch-action: none;
		user-select: none;
	}
	.bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		margin: 6px 0;
		font-size: 12px;
		flex-wrap: wrap;
	}
	.views button,
	.lnk {
		background: none;
		border: 1px solid var(--line-strong);
		color: inherit;
		font: inherit;
		font-size: 12px;
		padding: 1px 8px;
		border-radius: var(--r-sm);
		cursor: pointer;
		margin-left: 4px;
	}
	.views button.on {
		background: var(--accent-deep);
		border-color: var(--accent-line);
		color: var(--accent-strong);
	}
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: 16px;
		align-items: start;
	}
	@media (max-width: 800px) {
		.cols {
			grid-template-columns: 1fr;
		}
	}
	.dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 2px;
		margin-right: 6px;
		vertical-align: middle;
	}
	.mini {
		display: inline-block;
		width: 48px;
		height: 6px;
		background: var(--bg-sunken);
		border-radius: 2px;
		margin-right: 6px;
		vertical-align: middle;
		overflow: hidden;
	}
	.mini div {
		height: 100%;
	}
	.stack ol {
		margin: 6px 0 0;
		padding-left: 22px;
		font-size: 12px;
		line-height: 1.5;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.stack li {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
