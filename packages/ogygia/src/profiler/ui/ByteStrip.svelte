<script lang="ts">
	/**
	 * THE DOCUMENT AS A BYTE STRIP — one bar, every byte coloured by what it is (byte-strip.ts),
	 * with the time each part left the server (the strip is in write order) and, when this
	 * browser's visit is known, the time it arrived. A `wake:'load'` island: hover a segment, click
	 * a kind in the legend to light only that kind.
	 */
	import { arrival_ms, left_at, type ByteStrip, type StripKind, type StripSegment } from '../byte-strip.js';
	import { fmt_bytes, fmt_ms } from './format.js';

	let {
		strip,
		names = {},
		nav = null
	}: { strip: ByteStrip; names?: Record<string, string>; nav?: { res_start: number; res_end: number } | null } = $props();

	const COLOR: Record<StripKind, string> = {
		head: '#374151',
		style: '#d9a03d',
		'css-link': '#b8860b',
		runtime: '#8b5cf6',
		script: '#f0883e',
		seed: '#58a6ff',
		'remote-seed': '#1f6feb',
		props: '#79c0ff',
		holes: '#a371f7',
		island: '#2ea043',
		lake: '#3fb950',
		hole: '#56d364',
		shadow: '#ff7b72',
		markup: '#4b5563'
	};
	const LABEL: Record<StripKind, string> = {
		head: 'head markup',
		style: 'inline styles',
		'css-link': 'stylesheet links',
		runtime: 'runtime bootstrap',
		script: 'other scripts',
		seed: 'page seed',
		'remote-seed': 'remote seed',
		props: 'island props',
		holes: 'holes record',
		island: 'island markup',
		lake: 'lakes',
		hole: 'holes',
		shadow: 'shadow DOM',
		markup: 'markup'
	};
	const kinds = $derived((Object.keys(strip.by_kind) as StripKind[]).filter((k) => (strip.by_kind[k] ?? 0) > 0 && k !== 'shadow').sort((a, b) => (strip.by_kind[b] ?? 0) - (strip.by_kind[a] ?? 0)));
	let lit = $state<StripKind | null>(null);
	let tip = $state<{ s: StripSegment; x: number; y: number } | null>(null);
	const pct = (n: number) => (strip.total ? (n / strip.total) * 100 : 0);
	const name_of = (s: StripSegment) => (s.kind === 'island' && s.label ? (names[s.label] ?? s.label.slice(0, 8)) : s.label ?? '');
	const islands = $derived(strip.segments.filter((s) => s.kind === 'island'));
</script>

<div class="strip" role="img" aria-label="the document, byte by byte" onmouseleave={() => (tip = null)}>
	{#each strip.segments as s, i (i)}
		<div
			class="seg"
			class:dim={lit && s.kind !== lit}
			style="width:{Math.max(pct(s.end - s.start), 0.15)}%;background:{COLOR[s.kind]}"
			role="presentation"
			onmouseenter={(e) => (tip = { s, x: e.clientX, y: e.clientY })}
			onmousemove={(e) => (tip = { s, x: e.clientX, y: e.clientY })}
		></div>
	{/each}
</div>
{#if tip}
	<div class="tip" style="left:{tip.x + 12}px;top:{tip.y + 12}px">
		<b>{LABEL[tip.s.kind]}{name_of(tip.s) ? ` · ${name_of(tip.s)}` : ''}</b><br />
		{fmt_bytes(tip.s.end - tip.s.start)} · {pct(tip.s.end - tip.s.start).toFixed(1)}% of the document · bytes {tip.s.start.toLocaleString()}–{tip.s.end.toLocaleString()}
		{#if strip.chunks}{@const l0 = left_at(tip.s.start, strip.chunks)}{@const l1 = left_at(Math.max(tip.s.start, tip.s.end - 1), strip.chunks)}{#if l0 !== undefined && l1 !== undefined}<br />left the server {fmt_ms(l0)}{l1 !== l0 ? ` → ${fmt_ms(l1)}` : ''} ms into the render{/if}{/if}
		{#if nav}{@const a = arrival_ms(tip.s, strip.total, nav.res_start, nav.res_end)}<br />arrives {fmt_ms(a.first)} → {fmt_ms(a.last)} ms after the click (steady download assumed){/if}
	</div>
{/if}
{#if strip.chunks}
	<p class="hint">Streamed in {strip.chunks.length} chunks: the first left the server {fmt_ms(strip.chunks[0].t)} ms into the render, the last {fmt_ms(strip.chunks[strip.chunks.length - 1].t)} ms. Hover a segment for when its bytes left.</p>
{/if}
<div class="legend">
	{#each kinds as k (k)}
		<button class="key" class:on={lit === k} onclick={() => (lit = lit === k ? null : k)} title="click to light only this kind">
			<i style="background:{COLOR[k]}"></i>{LABEL[k]} <b>{fmt_bytes(strip.by_kind[k] ?? 0)}</b> <span class="hint">{pct(strip.by_kind[k] ?? 0).toFixed(0)}%</span>
		</button>
	{/each}
	{#if strip.shadow_count}
		<span class="key"><i style="background:{COLOR.shadow}"></i>shadow DOM inside the above <b>{fmt_bytes(strip.shadow_bytes)}</b> <span class="hint">{strip.shadow_count} roots</span></span>
	{/if}
	<span class="hint">total {fmt_bytes(strip.total)}</span>
</div>
{#if islands.length}
	<p class="hint">
		Islands in document order: {#each islands as s, i (i)}{#if i > 0}, {/if}<b>{name_of(s)}</b> {fmt_bytes(s.end - s.start)}{/each}.
		{#if nav}The last byte arrives {fmt_ms(nav.res_end)} ms after the click; everything after the seed and the props tail cannot paint before they do.{/if}
	</p>
{/if}

<style>
	.strip {
		display: flex;
		height: 26px;
		border-radius: 4px;
		overflow: hidden;
		border: 1px solid var(--line);
		background: var(--bg-sunken);
	}
	.seg {
		height: 100%;
		min-width: 1px;
		box-shadow: inset -1px 0 0 rgba(0, 0, 0, 0.35);
		transition: opacity 0.12s;
	}
	.seg.dim {
		opacity: 0.15;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 14px;
		margin: 8px 0 4px;
		font-size: 12px;
		align-items: center;
	}
	.key {
		background: none;
		border: 0;
		color: inherit;
		font: inherit;
		padding: 0;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.key.on {
		text-decoration: underline;
	}
	.key i {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		display: inline-block;
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
