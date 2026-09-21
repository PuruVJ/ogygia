<script lang="ts">
	/**
	 * THE DATA RIVER — calls → loads → page.data keys → islands as a flow (river.ts). Band width is
	 * the amount: ms on the left half (what the loads waited for), bytes on the right (what the seed
	 * carries and who reads it). A key that no island reads ends in red: fetched and shipped for no
	 * one. A `wake:'load'` island; hover a band or a node.
	 */
	import type { River, RiverNode, RiverLink } from '../river.js';
	import { fmt_bytes, fmt_ms } from './format.js';

	let { river }: { river: River } = $props();

	const W = 1000;
	const COL_X = [40, 300, 560, 820];
	const NODE_W = 12;
	const PAD = 8;
	const MIN_H = 8;
	const COLOR = ['#5b8fd6', '#4d9c6b', '#d9a03d', '#2ea043'];
	const waste_keys = $derived(new Set(river.waste.map((w) => w.key)));

	// layout: per column, node heights proportional to value (a column's own unit), stacked
	const layout = $derived.by(() => {
		const H_COL = 260;
		const pos = new Map<string, { x: number; y: number; h: number; n: RiverNode }>();
		for (let col = 0; col < 4; col++) {
			const nodes = river.nodes.filter((n) => n.col === col);
			if (!nodes.length) continue;
			const total = nodes.reduce((s, n) => s + Math.max(n.value, 0), 0) || 1;
			const avail = H_COL - PAD * (nodes.length - 1);
			let y = 20;
			for (const n of nodes) {
				const h = Math.max(MIN_H, (Math.max(n.value, 0) / total) * avail * 0.9);
				pos.set(n.id, { x: COL_X[col], y, h, n });
				y += h + PAD;
			}
		}
		// links: thickness per column pair, normalised to the biggest link of that pair; stacked on both ends
		const out_y = new Map<string, number>();
		const in_y = new Map<string, number>();
		const paths: { d: string; w: number; l: RiverLink; from: RiverNode; to: RiverNode; waste: boolean }[] = [];
		for (let col = 0; col < 3; col++) {
			const links = river.links.filter((l) => pos.get(l.from)?.n.col === col);
			const max = Math.max(...links.map((l) => l.value), 1);
			for (const l of links) {
				const a = pos.get(l.from);
				const b = pos.get(l.to);
				if (!a || !b) continue;
				const w = Math.max(2, (l.value / max) * Math.min(a.h, b.h, 40));
				const y0 = a.y + (out_y.get(l.from) ?? 0) + w / 2;
				const y1 = b.y + (in_y.get(l.to) ?? 0) + w / 2;
				out_y.set(l.from, (out_y.get(l.from) ?? 0) + w);
				in_y.set(l.to, (in_y.get(l.to) ?? 0) + w);
				const x0 = a.x + NODE_W;
				const x1 = b.x;
				const c = (x1 - x0) / 2;
				paths.push({ d: `M${x0},${y0} C${x0 + c},${y0} ${x1 - c},${y1} ${x1},${y1}`, w, l, from: a.n, to: b.n, waste: b.n.kind === 'key' && waste_keys.has(b.n.label) });
			}
		}
		const height = Math.max(...[...pos.values()].map((p) => p.y + p.h), 120) + 24;
		return { pos: [...pos.values()], paths, height };
	});
	let tip = $state<{ text: string; x: number; y: number } | null>(null);
	const move = (e: MouseEvent) => {
		if (tip) tip = { text: tip.text, x: e.clientX, y: e.clientY };
	};
	const fmt = (v: number, unit: 'ms' | 'bytes') => (unit === 'ms' ? `${fmt_ms(v)} ms` : fmt_bytes(v));
	const unit_of = (n: RiverNode): 'ms' | 'bytes' => (n.col <= 1 ? 'ms' : 'bytes');
	const HEAD = ['upstream calls (ms waited)', 'load functions', 'page.data keys (bytes in the seed)', 'islands (bytes they read)'];
</script>

<svg viewBox="0 0 {W} {layout.height}" class="river" role="img" aria-label="the data river" onmouseleave={() => (tip = null)}>
	{#each HEAD as h, i (h)}
		<text x={COL_X[i]} y="12" class="head">{h}</text>
	{/each}
	{#each layout.paths as p, i (i)}
		<path
			d={p.d}
			stroke={p.waste ? '#ff7b72' : COLOR[p.from.col]}
			stroke-width={p.w}
			fill="none"
			class="band"
			role="presentation"
			onmouseenter={(e) => (tip = { text: `${p.from.label} → ${p.to.label}: ${fmt(p.l.value, p.l.unit)}${p.waste ? ' — no island reads this key' : ''}`, x: e.clientX, y: e.clientY })}
			onmousemove={move}
		/>
	{/each}
	{#each layout.pos as p (p.n.id)}
		<rect x={p.x} y={p.y} width={NODE_W} height={p.h} fill={p.n.kind === 'key' && waste_keys.has(p.n.label) ? '#ff7b72' : p.n.kind === 'unknown' ? '#6b7280' : COLOR[p.n.col]} rx="2" role="presentation" onmouseenter={(e) => (tip = { text: `${p.n.label}: ${fmt(p.n.value, unit_of(p.n))}${p.n.detail ? ` — ${p.n.detail}` : ''}`, x: e.clientX, y: e.clientY })} onmousemove={move} />
		<text x={p.x + NODE_W + 5} y={p.y + Math.min(p.h, 14) / 2 + 4} class="label" class:waste={p.n.kind === 'key' && waste_keys.has(p.n.label)}>{p.n.label.length > 34 ? p.n.label.slice(0, 32) + '…' : p.n.label} <tspan class="val">{fmt(p.n.value, unit_of(p.n))}</tspan></text>
	{/each}
</svg>
{#if tip}
	<div class="tip" style="left:{tip.x + 12}px;top:{tip.y + 12}px">{tip.text}</div>
{/if}
{#each river.notes as n (n)}<p class="verdict">{n}</p>{/each}
<p class="hint">
	Left to right: what each upstream call cost the load that made it, what each load put into <code>page.data</code>, how big each key is in the seed the browser downloads, and which island reads it. A load whose source the profiler could not read shows its keys as unknown; a key in red ships to no island.
</p>

<style>
	.river {
		width: 100%;
		height: auto;
		display: block;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: 6px;
	}
	.head {
		fill: var(--text-dim);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.band {
		opacity: 0.45;
	}
	.band:hover {
		opacity: 0.85;
	}
	.label {
		fill: var(--text);
		font-size: 11px;
	}
	.label.waste {
		fill: var(--bad);
	}
	.val {
		fill: var(--text-faint);
	}
	.tip {
		position: fixed;
		z-index: 20;
		background: var(--bg-raised);
		border: 1px solid var(--line-strong);
		border-radius: 6px;
		padding: 6px 8px;
		font-size: 12px;
		max-width: 380px;
		pointer-events: none;
	}
</style>
