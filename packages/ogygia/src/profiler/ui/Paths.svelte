<script lang="ts">
	/**
	 * THE PATHS TO FIX — one graph per path group (analyze.ts `paths`): the caller to fix on the
	 * left, the chain of calls through to every hot function under it on the right. Link width and
	 * node bar are the hot time that flowed through; hot functions are lit, the rest of the chain
	 * dimmed. Hover a node for its time, click it to jump to its row. A `wake:'load'` island.
	 */
	import type { PathGroup, PathNode } from '../analyze.js';
	import { fmt_ms, fmt_pct, CATEGORY_COLOR } from './format.js';
	import { row_href } from './row-anchor.svelte.js';

	let { paths, busy }: { paths: PathGroup[]; busy: number } = $props();

	const COL = 236;
	const ROW = 30;
	const NODE_W = 204;
	const NODE_H = 22;
	const PAD = 8;

	interface Laid {
		n: PathNode;
		x: number;
		y: number;
		depth: number;
		parent: Laid | null;
	}
	/** a tidy left-to-right layout: leaves take rows in DFS order, a parent sits at its children's middle */
	function layout(root: PathNode): { nodes: Laid[]; width: number; height: number } {
		const nodes: Laid[] = [];
		let row = 0;
		let depth_max = 0;
		const place = (n: PathNode, depth: number, parent: Laid | null): Laid => {
			depth_max = Math.max(depth_max, depth);
			const me: Laid = { n, x: PAD + depth * COL, y: 0, depth, parent };
			nodes.push(me);
			if (!n.children.length) me.y = PAD + row++ * ROW;
			else {
				const kids = n.children.map((c) => place(c, depth + 1, me));
				me.y = (kids[0].y + kids[kids.length - 1].y) / 2;
			}
			return me;
		};
		place(root, 0, null);
		return { nodes, width: PAD * 2 + (depth_max + 1) * COL - (COL - NODE_W), height: PAD * 2 + Math.max(row, 1) * ROW };
	}
	const groups = paths.map((g) => ({ g, l: layout(g.tree) }));
	const link = (a: Laid, b: Laid) => {
		const x1 = a.x + NODE_W;
		const y1 = a.y + NODE_H / 2;
		const x2 = b.x;
		const y2 = b.y + NODE_H / 2;
		const mx = (x1 + x2) / 2;
		return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
	};
	const stroke = (n: PathNode, total: number) => 1 + 7 * Math.min(1, n.ms / Math.max(total, 0.01));
	const href = (n: PathNode) => (!n.key ? null : n.category === 'component' ? row_href(`comp:${n.name}`) : row_href(`fn:${n.key}`));
	const short = (s: string, max = 19) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
</script>

{#each groups as { g, l }, gi (g.owner.key)}
	<div class="path">
		<div class="head">
			<span class="no">{gi + 1}</span>
			<b>{g.fns.length} hot functions on one path under <a href={href(g.tree) ?? '#'}>{g.owner.name}</a></b>
			<span class="hint">
				· {fmt_ms(g.ms)} ms together ({fmt_pct(g.ms, busy)} of busy, {Math.round(g.share * 100)}% of what {g.owner.name} costs){#if g.owner.calls}
					· {g.owner.name} runs {g.owner.calls}×{/if}
			</span>
		</div>
		<div class="fix">
			Fix <b>{g.owner.name}</b> once — call it less, cache what it computes, or move it out of the render — and
			{g.fns.map((f) => f.name).join(', ')} go with it. Chasing them one by one gains the same time in {g.fns.length} places.
		</div>
		<div class="legend">
			<span><i class="sw owner"></i> the caller to fix</span>
			<span><i class="sw hot"></i> a hot function</span>
			<span><i class="sw"></i> a call between them</span>
			<span><i class="ln"></i> link width and the thin bar under a node = its share of the path's {fmt_ms(g.ms)} ms</span>
		</div>
		<div class="scroll">
			<svg width={l.width} height={l.height} viewBox="0 0 {l.width} {l.height}" role="img" aria-label="the call path from {g.owner.name} to its hot functions">
				{#each l.nodes as n (n.n.key + n.x + n.y)}
					{#if n.parent}
						<path d={link(n.parent, n)} fill="none" stroke={n.n.hot ? '#e8734a' : '#3a4250'} stroke-width={stroke(n.n, g.ms)} opacity="0.85" />
					{/if}
				{/each}
				{#each l.nodes as n (n.n.key + n.x + n.y + 'n')}
					{@const h = href(n.n)}
					<a href={h ?? undefined} class:dead={!h}>
						<g class="node" class:hot={n.n.hot} class:owner={n.depth === 0} transform="translate({n.x},{n.y})">
							<title>{n.n.name}{n.n.file ? ` (${n.n.file})` : ''} — {fmt_ms(n.n.ms)} ms of hot time through here{n.n.hot ? ' · a hot function' : ''}</title>
							<rect width={NODE_W} height={NODE_H} rx="5" />
							{#if n.depth > 0}
								<!-- the node's share of the path's time, in its category colour -->
								<rect class="bar" width={Math.max(2, (NODE_W - 12) * Math.min(1, n.n.ms / Math.max(g.ms, 0.01)))} height="2" x="6" y={NODE_H - 4} rx="1" fill={CATEGORY_COLOR[n.n.category] ?? '#6b7280'} opacity="0.8" />
							{/if}
							<text x="8" y="15">{short(n.n.name, n.n.calls ? 13 : 19)}</text>
							{#if n.n.calls}<text class="calls" x={NODE_W - 50} y="15" text-anchor="end">×{n.n.calls}</text>{/if}
							<text class="ms" x={NODE_W - 6} y="15" text-anchor="end">{fmt_ms(n.n.ms)}</text>
						</g>
					</a>
				{/each}
			</svg>
		</div>
	</div>
{/each}

<style>
	.path {
		margin: 8px 0 14px;
		padding: 10px 12px;
		background: var(--bg-raised);
		border: 1px solid var(--line);
		border-radius: 8px;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 8px;
		align-items: baseline;
		font-size: 13.5px;
	}
	.head .no {
		display: inline-block;
		width: 20px;
		height: 20px;
		line-height: 20px;
		text-align: center;
		border-radius: 50%;
		background: var(--c-orange);
		color: var(--bg-sunken);
		font-weight: 700;
		font-size: 12px;
	}
	.head .hint,
	.fix {
		color: var(--text-dim);
		font-size: 12.5px;
	}
	.fix {
		margin: 6px 0 4px;
		padding: 5px 10px;
		border-left: 3px solid var(--warn);
		background: var(--bg-raised);
		border-radius: 4px;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		margin: 4px 0 6px;
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.legend .sw {
		width: 12px;
		height: 10px;
		border-radius: 3px;
		background: var(--bg-hover);
		border: 1px solid var(--line);
		display: inline-block;
	}
	.legend .sw.owner {
		background: var(--accent-deep);
		border-color: var(--c-blue);
	}
	.legend .sw.hot {
		background: var(--warn-deep);
		border-color: var(--c-orange);
	}
	.legend .ln {
		width: 18px;
		height: 3px;
		background: var(--c-orange);
		border-radius: 2px;
		display: inline-block;
	}
	.scroll {
		overflow-x: auto;
	}
	svg {
		display: block;
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
	}
	.node rect:not(.bar) {
		fill: var(--bg-hover);
		stroke: var(--line);
	}
	.node.hot rect:not(.bar) {
		fill: var(--warn-deep);
		stroke: var(--c-orange);
	}
	.node.owner rect:not(.bar) {
		fill: var(--accent-deep);
		stroke: var(--c-blue);
		stroke-width: 1.5;
	}
	.node text {
		fill: var(--text-faint);
	}
	.node.hot text,
	.node.owner text {
		fill: var(--text);
	}
	.node .ms {
		fill: var(--text-dim);
	}
	.node .calls {
		fill: var(--text-faint);
		font-size: 9.5px;
	}
	a:hover .node rect:not(.bar) {
		stroke: var(--text);
	}
	a.dead {
		pointer-events: none;
	}
</style>
