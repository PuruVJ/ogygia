<script lang="ts">
	/**
	 * DOM TIME TRAVEL — each island's markup as the server sent it, after it hydrated, and when the
	 * page went away, with the diff between them (dom-diff.ts), plus the visit's layout shifts drawn
	 * on a page-shaped map with the island that moved. Browser-only data: the beacon keeps the
	 * snapshots in this browser's store (they are big), never on the server. A `wake:'load'` island.
	 */
	import { html_diff, shift_boxes, type HtmlDiff } from '../dom-diff.js';
	import { latest_visit, type StoredVisit } from './store.js';
	import type { Visit } from '../visit.js';

	let { page, names = {}, visit = null }: { page: string; names?: Record<string, string>; visit?: Visit | null } = $props();

	let rec = $state<StoredVisit | null>(null);
	let looked = $state(false);
	void latest_visit(page)
		.then((r) => (rec = r))
		.finally(() => (looked = true));
	const v = $derived((rec?.visit as Visit | undefined) ?? visit);
	const boxes = $derived(v ? shift_boxes(v.shifts, v.viewport) : []);
	const cls_total = $derived(boxes.reduce((s, b) => s + b.value, 0));
	const name = (fp: string | undefined) => (fp ? (names[fp] ?? fp.slice(0, 8)) : 'outside any island');
	let picked = $state<string | null>(null);
	let moment = $state<'hydrated' | 'final'>('hydrated');
	const snap = $derived(rec?.snapshots.find((s) => s.fp === picked) ?? rec?.snapshots[0] ?? null);
	const diff = $derived<HtmlDiff | null>(snap ? html_diff(snap.ssr, moment === 'final' && snap.final !== undefined ? snap.final : snap.hydrated) : null);
	const VW = 240;
	const vh = $derived(v?.viewport ? Math.round((VW * v.viewport[1]) / v.viewport[0]) : 160);
</script>

{#if v && (boxes.length || rec?.snapshots.length)}
	<div class="travel">
		<div class="map">
			<h3 class="sub-h">Layout shifts <span class="hint">{cls_total.toFixed(3)} CLS in this visit, where and whose</span></h3>
			<svg viewBox="0 0 {VW} {vh}" width={VW} height={vh} class="viewport" role="img" aria-label="layout shifts on the viewport">
				<rect x="0" y="0" width={VW} height={vh} class="vp" />
				{#each boxes as b, i (i)}
					<rect x={b.fx * VW} y={b.fy * vh} width={Math.max(b.w * VW, 2)} height={Math.max(b.h * vh, 2)} class="from" />
					<rect x={b.x * VW} y={b.y * vh} width={Math.max(b.w * VW, 2)} height={Math.max(b.h * vh, 2)} class="to" style="opacity:{0.35 + Math.min(0.6, b.value * 3)}">
						<title>{name(b.fp)} · {b.value.toFixed(3)} at {Math.round(b.t)} ms</title>
					</rect>
					<line x1={b.fx * VW + (b.w * VW) / 2} y1={b.fy * vh + (b.h * vh) / 2} x2={b.x * VW + (b.w * VW) / 2} y2={b.y * vh + (b.h * vh) / 2} class="arrow" />
				{/each}
			</svg>
			{#if boxes.length}
				<ul class="shifts">
					{#each boxes.slice(0, 8) as b, i (i)}
						<li><b>{name(b.fp)}</b> {b.value.toFixed(3)} <span class="hint">at {Math.round(b.t)} ms</span></li>
					{/each}
				</ul>
			{:else}
				<p class="hint">No layout shift in this visit.</p>
			{/if}
		</div>
		<div class="diff">
			<h3 class="sub-h">Markup, then and now <span class="hint">{rec?.snapshots.length ?? 0} island{(rec?.snapshots.length ?? 0) === 1 ? '' : 's'} changed between the server and the browser</span></h3>
			{#if rec?.snapshots.length}
				<p class="pick">
					{#each rec.snapshots as s (s.fp)}
						<button class:on={snap?.fp === s.fp} onclick={() => (picked = s.fp)}>{name(s.fp)}</button>
					{/each}
					<span class="hint">· server →</span>
					<button class:on={moment === 'hydrated'} onclick={() => (moment = 'hydrated')}>hydrated</button>
					{#if snap?.final !== undefined}<button class:on={moment === 'final'} onclick={() => (moment = 'final')}>when the page left</button>{/if}
				</p>
				{#if diff}
					<p class="hint">{diff.removed.toLocaleString()} chars gone, {diff.added.toLocaleString()} added, {Math.round(diff.same_ratio * 100)}% of the tokens unchanged{diff.truncated ? ' (too large to diff token by token: shown as one removal and one addition)' : ''}.</p>
					<pre class="d">{#each diff.ops as op, i (i)}<span class={op.kind}>{op.text}</span>{/each}</pre>
				{/if}
			{:else}
				<p class="hint">Every island's markup after hydration matched what the server sent.</p>
			{/if}
		</div>
	</div>
{:else if looked}
	<p class="hint">No visit of <code>{page}</code> kept in this browser. Open the page once while logged in to the profiler; the beacon stores the islands' markup before and after hydration and the layout shifts here.</p>
{:else}
	<p class="hint">Reading this browser's visit…</p>
{/if}

<style>
	.travel {
		display: grid;
		grid-template-columns: 280px 1fr;
		gap: 20px;
		align-items: start;
	}
	@media (max-width: 800px) {
		.travel {
			grid-template-columns: 1fr;
		}
	}
	.viewport {
		display: block;
		border: 1px solid var(--line);
		border-radius: 4px;
		background: var(--bg-sunken);
	}
	.vp {
		fill: var(--bg-sunken);
	}
	.from {
		fill: none;
		stroke: #6b7280;
		stroke-dasharray: 3 2;
	}
	.to {
		fill: var(--bad);
		stroke: var(--bad);
	}
	.arrow {
		stroke: var(--warn);
		stroke-width: 1;
	}
	.shifts {
		margin: 6px 0 0;
		padding-left: 18px;
		font-size: 12px;
	}
	.pick button {
		background: var(--bg-raised);
		border: 1px solid var(--line-strong);
		color: inherit;
		border-radius: 4px;
		padding: 2px 8px;
		margin: 0 4px 4px 0;
		cursor: pointer;
		font: inherit;
		font-size: 12px;
	}
	.pick button.on {
		border-color: var(--c-blue);
	}
	.d {
		max-height: 360px;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-all;
		font-size: 11px;
		line-height: 1.4;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: 4px;
		padding: 8px;
	}
	.d .add {
		background: rgba(46, 160, 67, 0.35);
	}
	.d .del {
		background: rgba(255, 123, 114, 0.35);
		text-decoration: line-through;
	}
	.d .same {
		color: var(--text-dim);
	}
</style>
