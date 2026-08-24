<script lang="ts">
	/**
	 * CPU treemap — a `wake:'load'` canvas island (was TREE_JS). Squarified layout of self-time,
	 * root → category → leaf; click a box to drill in, the breadcrumb zooms back out; hover for detail.
	 * The zoom stack and tooltip are `$state`; the canvas redraws in an `$effect` when either the stack
	 * or a resize changes. `rects` (hit regions) is plain (non-reactive) — it's rebuilt each draw.
	 */
	interface Leaf {
		label: string;
		value: number;
		color: string;
		pct?: number;
		sub?: string;
		children?: Leaf[];
	}
	let { hierarchy }: { hierarchy: Leaf } = $props();

	const H = 440;
	let canvas: HTMLCanvasElement;
	let stack = $state<Leaf[]>([hierarchy]);
	let resizeTick = $state(0);
	let tip = $state<{ node: Leaf; x: number; y: number } | null>(null);
	let rects: { x: number; y: number; w: number; h: number; node: Leaf; zoom: Leaf | null }[] = [];

	interface Cell {
		it: Leaf;
		x: number;
		y: number;
		w: number;
		h: number;
	}
	function squarify(items: Leaf[], x: number, y: number, w: number, h: number): Cell[] {
		const out: Cell[] = [];
		let total = 0;
		for (const it of items) total += it.value;
		if (total <= 0 || w <= 0 || h <= 0) return out;
		const scale = (w * h) / total;
		let rest = items.map((it) => ({ it, area: it.value * scale }));
		let rx = x,
			ry = y,
			rw = w,
			rh = h;
		const worst = (row: { area: number }[], side: number) => {
			let sum = 0,
				mx = 0,
				mn = Infinity;
			for (const r of row) {
				sum += r.area;
				if (r.area > mx) mx = r.area;
				if (r.area < mn) mn = r.area;
			}
			const s2 = sum * sum;
			return Math.max((side * side * mx) / s2, s2 / (side * side * mn));
		};
		while (rest.length) {
			const side = Math.min(rw, rh);
			const row: { it: Leaf; area: number }[] = [];
			let idx = 0;
			while (idx < rest.length) {
				if (row.length === 0 || worst(row.concat([rest[idx]]), side) <= worst(row, side)) {
					row.push(rest[idx]);
					idx++;
				} else break;
			}
			let rowSum = 0;
			for (const r of row) rowSum += r.area;
			if (rw <= rh) {
				const sH = rowSum / rw;
				let cx = rx;
				for (const r of row) {
					const iw = r.area / sH;
					out.push({ it: r.it, x: cx, y: ry, w: iw, h: sH });
					cx += iw;
				}
				ry += sH;
				rh -= sH;
			} else {
				const sW = rowSum / rh;
				let cy = ry;
				for (const r of row) {
					const ih = r.area / sW;
					out.push({ it: r.it, x: rx, y: cy, w: sW, h: ih });
					cy += ih;
				}
				rx += sW;
				rw -= sW;
			}
			rest = rest.slice(row.length);
		}
		return out;
	}

	function draw() {
		if (!canvas) return;
		const ctx = canvas.getContext('2d')!;
		const dpr = window.devicePixelRatio || 1;
		const W = canvas.clientWidth || 900;
		canvas.width = W * dpr;
		canvas.height = H * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, W, H);
		rects = [];
		const box = (x: number, y: number, w: number, h: number, color: string, alpha: number) => {
			ctx.globalAlpha = alpha;
			ctx.fillStyle = color;
			ctx.fillRect(x, y, Math.max(0, w - 1), Math.max(0, h - 1));
			ctx.globalAlpha = 1;
		};
		const label = (x: number, y: number, w: number, txt: string, sub: string) => {
			if (w < 46) return;
			ctx.fillStyle = '#0d1014';
			ctx.font = '600 10px ui-monospace,monospace';
			ctx.save();
			ctx.beginPath();
			ctx.rect(x + 2, y, w - 4, 20);
			ctx.clip();
			ctx.fillText(txt, x + 4, y + 11);
			if (sub) {
				ctx.font = '9px ui-monospace,monospace';
				ctx.globalAlpha = 0.75;
				ctx.fillText(sub, x + 4, y + 21);
				ctx.globalAlpha = 1;
			}
			ctx.restore();
		};
		const cur = stack[stack.length - 1];
		const atRoot = stack.length === 1;
		const cells = squarify(cur.children ?? [], 0, 0, W, H);
		for (const c of cells) {
			const node = c.it;
			if (node.children && atRoot) {
				box(c.x, c.y, c.w, c.h, node.color, 0.16);
				if (c.w > 60 && c.h > 22) {
					ctx.fillStyle = node.color;
					ctx.font = '700 11px ui-monospace,monospace';
					ctx.save();
					ctx.beginPath();
					ctx.rect(c.x + 2, c.y, c.w - 4, 14);
					ctx.clip();
					ctx.fillText(node.label + ' · ' + node.value + ' ms', c.x + 4, c.y + 11);
					ctx.restore();
				}
				const inner = squarify(node.children, c.x + 2, c.y + 15, Math.max(0, c.w - 4), Math.max(0, c.h - 17));
				for (const ic of inner) {
					const leaf = ic.it;
					const op = 0.55 + Math.min(0.4, (leaf.pct ?? 0) / 40);
					box(ic.x, ic.y, ic.w, ic.h, leaf.color, op);
					if (ic.w > 46 && ic.h > 14) label(ic.x, ic.y, ic.w, leaf.label, ic.h > 26 ? leaf.value + ' ms' : '');
					rects.push({ x: ic.x, y: ic.y, w: ic.w, h: ic.h, node: leaf, zoom: node });
				}
				rects.push({ x: c.x, y: c.y, w: c.w, h: 15, node, zoom: node });
			} else {
				const op = 0.55 + Math.min(0.4, (node.pct ?? 0) / 40);
				box(c.x, c.y, c.w, c.h, node.color, op);
				if (c.w > 46 && c.h > 16) {
					ctx.fillStyle = '#0d1014';
					ctx.font = '600 11px ui-monospace,monospace';
					ctx.save();
					ctx.beginPath();
					ctx.rect(c.x + 3, c.y, c.w - 6, 30);
					ctx.clip();
					ctx.fillText(node.label, c.x + 4, c.y + 13);
					if (c.h > 28) {
						ctx.font = '9px ui-monospace,monospace';
						ctx.globalAlpha = 0.8;
						ctx.fillText(node.value + ' ms', c.x + 4, c.y + 24);
						ctx.globalAlpha = 1;
					}
					ctx.restore();
				}
				rects.push({ x: c.x, y: c.y, w: c.w, h: c.h, node, zoom: node.children ? node : null });
			}
		}
	}

	// redraw when the zoom stack changes or the window resizes; the effect reads both so it re-runs.
	$effect(() => {
		stack;
		resizeTick;
		draw();
	});
	$effect(() => {
		const on = () => resizeTick++;
		window.addEventListener('resize', on);
		return () => window.removeEventListener('resize', on);
	});

	function at(ev: MouseEvent) {
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
		const q = at(ev);
		if (!q || !q.node.label) {
			tip = null;
			return;
		}
		tip = { node: q.node, x: Math.min(ev.clientX + 14, window.innerWidth - 430), y: ev.clientY + 14 };
	}
	function onClick(ev: MouseEvent) {
		const q = at(ev);
		if (q && q.zoom && q.zoom.children) stack = [...stack, q.zoom];
	}
	function zoomOut(ev: Event) {
		ev.preventDefault();
		stack = stack.slice(0, -1);
	}
</script>

<div class="crumb">
	{#if stack.length === 1}
		<span style="color:#7d8590">click a box to zoom in</span>
	{:else}
		{stack.slice(1).map((n) => n.label).join(' › ')} —
		<a href="#top" onclick={zoomOut}>zoom out</a>
	{/if}
</div>
<canvas
	class="tree"
	bind:this={canvas}
	onmousemove={onMove}
	onmouseleave={() => (tip = null)}
	onclick={onClick}
></canvas>
{#if tip}
	<div class="tree-tip" style="display:block;left:{tip.x}px;top:{tip.y}px">
		<b>{tip.node.label}</b>
		{#if tip.node.sub}<br /><span style="color:#7d8590">{tip.node.sub}</span>{/if}
		<br />{tip.node.value} ms{#if tip.node.pct != null} · {tip.node.pct}% of busy{/if}
	</div>
{/if}
