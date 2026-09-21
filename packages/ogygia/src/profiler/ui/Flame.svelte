<script lang="ts">
	/**
	 * Flame graph — a `wake:'load'` canvas island (was FLAME_JS). Width = time; click a bar to zoom,
	 * click the top bar to zoom back out; hover for detail. Zoom + tooltip are `$state`; the canvas
	 * redraws in an `$effect` on zoom/resize. `rects` (hit regions) is plain, rebuilt each draw.
	 */
	import type { FlameNode } from '../analyze.js';
	import { CATEGORY_COLOR } from './format.js';

	let { flame }: { flame: FlameNode } = $props();

	const ROW = 20;
	let canvas: HTMLCanvasElement;
	let zoom = $state<FlameNode>(flame);
	let zstack: FlameNode[] = [];
	let resizeTick = $state(0);
	let tip = $state<{ node: FlameNode; x: number; y: number } | null>(null);
	let rects: { x: number; y: number; w: number; h: number; node: FlameNode }[] = [];
	// SEARCH: bars whose name or file contains the query stay lit, everything else dims; the count
	// and the summed time tell how much of the graph the match covers; Enter zooms to the heaviest hit.
	let query = $state('');
	const q = $derived(query.trim().toLowerCase());
	const matches = $derived.by(() => {
		if (!q) return { count: 0, ms: 0, best: null as FlameNode | null };
		let count = 0,
			ms = 0,
			best: FlameNode | null = null;
		const walk = (n: FlameNode, inside: boolean) => {
			const hit = n.n.toLowerCase().includes(q) || n.f.toLowerCase().includes(q);
			if (hit) {
				count++;
				if (!best || n.t > best.t) best = n;
			}
			// time counts once per matching subtree (a match inside a match is already covered)
			if (hit && !inside) ms += n.t;
			for (const c of n.ch ?? []) walk(c, inside || hit);
		};
		walk(flame, false);
		return { count, ms, best };
	});
	const is_match = (n: FlameNode) =>
		!!q && (n.n.toLowerCase().includes(q) || n.f.toLowerCase().includes(q));
	function zoom_to_match() {
		const best = matches.best;
		if (!best || best === zoom) return;
		zstack.push(zoom);
		zoom = best;
	}

	function depth(n: FlameNode): number {
		let d = 1;
		for (const c of n.ch ?? []) d = Math.max(d, 1 + depth(c));
		return d;
	}

	function layout() {
		if (!canvas) return;
		const ctx = canvas.getContext('2d')!;
		const dpr = window.devicePixelRatio || 1;
		const w = canvas.clientWidth || 900;
		const h = Math.min(600, Math.max(260, depth(zoom) * ROW + 10));
		canvas.style.height = h + 'px';
		canvas.width = w * dpr;
		canvas.height = h * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);
		rects = [];
		const draw = (node: FlameNode, d: number, x: number, width: number) => {
			if (width < 0.5) return;
			const y = d * ROW;
			ctx.fillStyle = CATEGORY_COLOR[node.c] || '#6b7280';
			ctx.globalAlpha = q ? (is_match(node) ? 1 : 0.22) : 1;
			ctx.beginPath();
			if (ctx.roundRect) ctx.roundRect(x + 0.5, y + 1, Math.max(width - 1, 1), ROW - 2, 2);
			else ctx.rect(x + 0.5, y + 1, Math.max(width - 1, 1), ROW - 2);
			ctx.fill();
			if (width > 30) {
				ctx.fillStyle = '#0d1014';
				ctx.font = '11px ui-monospace, monospace';
				ctx.save();
				ctx.beginPath();
				ctx.rect(x + 4, y, width - 8, ROW);
				ctx.clip();
				ctx.fillText(node.n + ' (' + node.t.toFixed(1) + 'ms)', x + 5, y + 14);
				ctx.restore();
			}
			ctx.globalAlpha = 1;
			rects.push({ x, y, w: width, h: ROW, node });
			let cx = x;
			const scale = node.t > 0 ? width / node.t : 0;
			for (const c of node.ch ?? []) {
				const cw = c.t * scale;
				draw(c, d + 1, cx, cw);
				cx += cw;
			}
		};
		draw(zoom, 0, 0, w);
	}

	$effect(() => {
		zoom;
		resizeTick;
		q;
		layout();
	});
	$effect(() => {
		const on = () => resizeTick++;
		window.addEventListener('resize', on);
		return () => window.removeEventListener('resize', on);
	});

	function hit(ev: MouseEvent) {
		const r = canvas.getBoundingClientRect();
		const mx = ev.clientX - r.left,
			my = ev.clientY - r.top;
		for (let i = rects.length - 1; i >= 0; i--) {
			const q = rects[i];
			if (mx >= q.x && mx <= q.x + q.w && my >= q.y && my <= q.y + q.h) return q;
		}
		return null;
	}
	function onMove(ev: MouseEvent) {
		const q = hit(ev);
		tip = q ? { node: q.node, x: Math.min(ev.clientX + 14, window.innerWidth - 360), y: ev.clientY + 14 } : null;
	}
	function onClick(ev: MouseEvent) {
		const q = hit(ev);
		if (!q) return;
		if (q.node === zoom) zoom = zstack.pop() || flame;
		else {
			zstack.push(zoom);
			zoom = q.node;
		}
	}
</script>

<div class="tools">
	<input
		type="search"
		placeholder="find a function or file in the graph…"
		bind:value={query}
		onkeydown={(e) => e.key === 'Enter' && zoom_to_match()}
		aria-label="search the flame graph"
	/>
	{#if q}
		<span class="hint">
			{#if matches.count}
				{matches.count} bar{matches.count === 1 ? '' : 's'} · {matches.ms.toFixed(1)} ms · Enter zooms to
				the heaviest
			{:else}no match{/if}
		</span>
	{/if}
	<span class="crumb">
		{#if zoom !== flame}zoomed: {zoom.n} — click the top bar to go back{/if}
	</span>
</div>
<canvas
	class="flame"
	bind:this={canvas}
	onmousemove={onMove}
	onmouseleave={() => (tip = null)}
	onclick={onClick}
></canvas>
{#if tip}
	<div class="flame-tip" style="display:block;left:{tip.x}px;top:{tip.y}px">
		<b>{tip.node.n}</b><br />total {tip.node.t.toFixed(2)} ms · self {tip.node.s.toFixed(2)} ms
		{#if tip.node.f}<br /><span style="color:#7d8590">{tip.node.f}</span>{/if}
	</div>
{/if}

<style>
	.tools {
		display: flex;
		gap: 12px;
		align-items: center;
		flex-wrap: wrap;
		margin: 6px 0 8px;
	}
	.tools input {
		font: inherit;
		font-size: 13px;
		background: var(--bg-raised);
		color: var(--text);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 5px 10px;
		min-width: 280px;
	}
	.tools .hint,
	.tools .crumb {
		color: var(--text-faint);
		font-size: 12px;
	}
	.flame {
		width: 100%;
		height: 460px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--bg-sunken);
		cursor: pointer;
	}
	.flame-tip {
		position: fixed;
		pointer-events: none;
		background: var(--bg-hover);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 12px;
		display: none;
		max-width: 480px;
		z-index: 10;
		box-shadow: 0 4px 16px #0008;
	}
	.flame-tip b {
		font-family: ui-monospace, monospace;
	}
</style>
