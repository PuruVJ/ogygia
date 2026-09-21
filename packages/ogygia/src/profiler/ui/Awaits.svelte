<script lang="ts">
	/**
	 * THE CAUSALITY GRAPH of a render's waits (timeline.ts `awaits`): every call is a box on the
	 * render's clock, overlapping calls in their own lanes, and an arrow wherever a call started
	 * only once another had finished — the await that serialized them, labelled with the line that
	 * did the waiting. Parallel calls read as stacked boxes with no arrow between them. Hover a box
	 * or an arrow for the detail. A `wake:'load'` island.
	 */
	import type { AwaitNode, AwaitEdge } from '../timeline.js';
	import { fmt_ms } from './format.js';
	import { simulate_awaits, type WhatIf } from '../insights.js';

	let { nodes, edges, window_ms }: { nodes: AwaitNode[]; edges: AwaitEdge[]; window_ms: number } = $props();

	const W = 1100;
	const LANE = 26;
	const H = 18;
	const PAD = 8;
	const LEFT = 8;
	const x = (t: number) => LEFT + (t / Math.max(window_ms, 0.01)) * (W - 2 * LEFT);
	const lanes = nodes.reduce((m, n) => Math.max(m, n.lane + 1), 1);
	const height = PAD * 2 + lanes * LANE;
	const by_label = new Map<string, AwaitNode[]>();
	for (const n of nodes) (by_label.get(n.label) ?? by_label.set(n.label, []).get(n.label)!).push(n);
	// an edge joins the last box of `from` that ended before the first box of `to` starting after it
	const placed = edges
		.map((e) => {
			const froms = by_label.get(e.from) ?? [];
			const tos = by_label.get(e.to) ?? [];
			let best: { a: AwaitNode; b: AwaitNode } | null = null;
			for (const b of tos) for (const a of froms) if (a.t1 <= b.t0 + 0.05 && (!best || a.t1 > best.a.t1)) best = { a, b };
			return best ? { e, ...best } : null;
		})
		.filter((p): p is { e: AwaitEdge; a: AwaitNode; b: AwaitNode } => !!p);
	// fixed mid-tone series colours (SVG `fill` attributes can't take a CSS var); they read on both themes
	const color = (kind: string) => (kind === 'net' ? '#6ca8e0' : '#e0a06f');
	const short = (s: string, px: number) => {
		const max = Math.max(3, Math.floor(px / 6.6));
		return s.length > max ? s.slice(0, max - 1) + '…' : s;
	};
	let tip = $state<{ text: string; x: number; y: number } | null>(null);
	const show = (text: string, ev: MouseEvent) => (tip = { text, x: ev.clientX, y: ev.clientY });
	const serialized_ms = edges.reduce((s, e) => s + e.gap_ms, 0);
	// WHAT IF: change a call and see the render under the model (insights.ts)
	let changes = $state<Record<string, WhatIf>>({});
	const labels = [...new Set(nodes.map((n) => n.label))];
	const sim = $derived(Object.keys(changes).length ? simulate_awaits(nodes, edges, window_ms, changes) : null);
	const set_change = (label: string, c: WhatIf | null) => {
		const next = { ...changes };
		if (c === null || next[label] === c) delete next[label];
		else next[label] = c;
		changes = next;
	};
</script>

<div class="legend">
	<span><i style="background:{color('net')}"></i> HTTP call</span>
	<span><i style="background:{color('timer')}"></i> timer / file / socket</span>
	<span><i class="arrow"></i> started only once the other finished — the await that serialized them</span>
	<span class="hint">{edges.length} serialized start{edges.length === 1 ? '' : 's'} · boxes in the same column ran together</span>
</div>
<div class="scroll" onmouseleave={() => (tip = null)}>
	<svg width={W} {height} viewBox="0 0 {W} {height}" role="img" aria-label="the render's calls and which one waited for which">
		<defs>
			<marker id="aw-head" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#e0834a" /></marker>
		</defs>
		{#each nodes as n, i (i)}
			<g
				class="node"
				transform="translate({x(n.t0)},{PAD + n.lane * LANE})"
				onmouseenter={(ev) => show(`${n.label} — ${fmt_ms(n.t1 - n.t0)} ms, from ${fmt_ms(n.t0)} to ${fmt_ms(n.t1)} ms${n.caller ? ` · from ${n.caller}` : ''}`, ev)}
				onmousemove={(ev) => show(`${n.label} — ${fmt_ms(n.t1 - n.t0)} ms, from ${fmt_ms(n.t0)} to ${fmt_ms(n.t1)} ms${n.caller ? ` · from ${n.caller}` : ''}`, ev)}
				role="img"
			>
				<rect width={Math.max(2, x(n.t1) - x(n.t0))} height={H} rx="3" fill={color(n.kind)} opacity="0.85" />
				<text x="4" y="13">{short(n.label, x(n.t1) - x(n.t0) - 6)}</text>
			</g>
		{/each}
		{#each placed as p, i (i)}
			{@const x1 = x(p.a.t1)}
			{@const y1 = PAD + p.a.lane * LANE + H / 2}
			{@const x2 = x(p.b.t0)}
			{@const y2 = PAD + p.b.lane * LANE + H / 2}
			<path
				class="edge"
				d={p.a.lane === p.b.lane ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} C${x1 + 12},${y1} ${x2 - 12},${y2} ${x2},${y2}`}
				marker-end="url(#aw-head)"
				onmouseenter={(ev) => show(`${p.e.to} started ${fmt_ms(p.e.gap_ms)} ms after ${p.e.from} finished${p.e.at ? ` — awaited at ${p.e.at}` : ''}${p.e.callers && p.e.callers.length > 1 ? ` (${p.e.callers.join(' ← ')})` : ''}`, ev)}
				onmousemove={(ev) => show(`${p.e.to} started ${fmt_ms(p.e.gap_ms)} ms after ${p.e.from} finished${p.e.at ? ` — awaited at ${p.e.at}` : ''}`, ev)}
				role="img"
			/>
		{/each}
	</svg>
</div>
{#if tip}
	<div class="tip" style="left:{Math.min(tip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 420)}px;top:{tip.y + 16}px">{tip.text}</div>
{/if}
{#if placed.length}
	<ol class="sites">
		{#each placed.slice(0, 12) as p, i (i)}
			<li><b>{p.e.to}</b> waited for <b>{p.e.from}</b>{#if p.e.at} — at <code>{p.e.at}</code>{/if}{#if p.e.gap_ms >= 1} <span class="hint">({fmt_ms(p.e.gap_ms)} ms between)</span>{/if}</li>
		{/each}
		{#if placed.length > 12}<li class="hint">and {placed.length - 12} more</li>{/if}
	</ol>
	<p class="hint">{serialized_ms >= 1 ? `${fmt_ms(serialized_ms)} ms sat between serialized calls. ` : ''}Each line is an <code>await</code> that could start its call earlier: move the call above the await it waits behind, and the two overlap.</p>
{:else}
	<p class="hint">No call waited for another: every call started while the previous ones were still in flight.</p>
{/if}

{#if labels.length}
	<details class="whatif">
		<summary>What if… <span class="hint">change a call and see the render under the model: parallel starts it with the call it waited for, cache makes it instant, remove takes it out</span></summary>
		<div class="whatif-grid">
			{#each labels.slice(0, 40) as label (label)}
				<div class="row">
					<span class="lbl">{label}</span>
					<button class:on={changes[label] === 'parallel'} onclick={() => set_change(label, 'parallel')}>parallel</button>
					<button class:on={changes[label] === 'cache'} onclick={() => set_change(label, 'cache')}>cache</button>
					<button class:on={changes[label] === 'remove'} onclick={() => set_change(label, 'remove')}>remove</button>
				</div>
			{/each}
		</div>
		{#if sim}
			<p class="result">
				<b>{fmt_ms(sim.before_ms)} ms → {fmt_ms(sim.after_ms)} ms</b> <span class={sim.delta_ms < 0 ? 'better' : 'worse'}>({sim.delta_ms > 0 ? '+' : ''}{fmt_ms(sim.delta_ms)} ms)</span>
				<button class="link" onclick={() => (changes = {})}>reset</button>
			</p>
			{#if sim.chain.length}<p class="hint">The longest chain of waits would then be: {sim.chain.join(' → ')}. The CPU between calls is kept as recorded; only the waits move.</p>{/if}
		{/if}
	</details>
{/if}

<style>
	.whatif {
		margin-top: 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		padding: 8px 12px;
	}
	.whatif summary {
		cursor: pointer;
		font-weight: 600;
	}
	.whatif-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 3px;
		margin-top: 8px;
		max-height: 260px;
		max-width: 560px;
		overflow: auto;
	}
	.whatif .row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto auto;
		gap: 6px;
		align-items: center;
		font-size: 12px;
	}
	.whatif .lbl {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-family: var(--font-mono);
	}
	.whatif button {
		background: var(--bg-hover);
		border: 1px solid var(--line-strong);
		color: var(--text-dim);
		border-radius: var(--r-sm);
		padding: 1px 7px;
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}
	.whatif button:hover {
		border-color: var(--accent-line);
		color: var(--text);
	}
	.whatif button.on {
		border-color: var(--accent);
		background: var(--accent-deep);
		color: var(--accent-strong);
	}
	.whatif .result {
		margin: 8px 0 2px;
		font-size: 13px;
	}
	.whatif .link {
		border: 0;
		background: none;
		text-decoration: underline;
		margin-left: 8px;
		color: var(--accent);
		cursor: pointer;
	}
	.better {
		color: var(--good);
	}
	.worse {
		color: var(--bad);
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		margin: 6px 0 4px;
		font-size: 11.5px;
		color: var(--text-dim);
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.legend i {
		width: 12px;
		height: 12px;
		border-radius: 2px;
		display: inline-block;
	}
	.legend i.arrow {
		width: 18px;
		height: 2px;
		background: var(--c-orange);
	}
	.legend .hint {
		flex-basis: 100%;
		color: var(--text-faint);
	}
	.scroll {
		overflow-x: auto;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: var(--r-md);
	}
	svg {
		display: block;
		font-family: var(--font-mono);
		font-size: 10.5px;
	}
	.node text {
		fill: #06120c;
		font-weight: 600;
		pointer-events: none;
	}
	.tip {
		position: fixed;
		pointer-events: none;
		background: var(--bg-raised);
		color: var(--text);
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		padding: 6px 10px;
		font-size: 12px;
		max-width: 480px;
		z-index: 10;
		box-shadow: var(--shadow-panel);
	}
	.edge {
		fill: none;
		stroke: var(--c-orange);
		stroke-width: 1.6;
		cursor: help;
	}
	.edge:hover {
		stroke-width: 3;
	}
	.sites {
		margin: 8px 0 0;
		padding-left: 22px;
		font-size: 12.5px;
		line-height: 1.6;
	}
	.sites code {
		font-size: 11.5px;
	}
	.hint {
		color: var(--text-faint);
		font-size: 12px;
	}
</style>
