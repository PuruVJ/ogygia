<script lang="ts">
	/**
	 * THE DRILL-DOWN (drill.ts): one render's time as a tree that adds up at every level — phase →
	 * who held it (a function, a library, a call) → the line. Static markup: `<details>` open the
	 * levels, no island. Each bar is its share of the whole render.
	 */
	import type { DrillNode } from '../drill.js';
	import { PATTERN_LABEL, type PatternKind } from '../patterns.js';
	import { fmt_ms } from './format.js';

	let { root }: { root: DrillNode } = $props();

	const KIND: Record<DrillNode['kind'], string> = {
		render: '',
		phase: '',
		lane: 'load file',
		cpu: 'CPU',
		wait: 'waiting',
		gap: 'nothing recorded',
		line: '',
		more: ''
	};
</script>

{#snippet kind(n: DrillNode)}
	{#if KIND[n.kind]}
		<span class="dr-kind {n.kind}">
			{KIND[n.kind]}{#if n.calls && n.calls > 1} · {n.calls} {n.kind === 'cpu' ? 'renders' : 'calls'}{/if}
			{#if n.runs}<span title="Its lowest and highest over the profiled renders (for a wait: its calls' own time, which the network makes jitter): a difference smaller than this spread is noise"> · {n.kind === 'wait' ? 'calls took ' : ''}{fmt_ms(n.runs[0])}–{fmt_ms(n.runs[1])} ms over renders</span>{/if}
			{#if n.cold !== undefined}<span class="dr-cold" title="What it took in the first, cold render (loading and compiling its code, filling first-call caches): what a fresh serverless instance pays on its first request"> · {fmt_ms(n.cold)} ms cold</span>{/if}
			{#if n.alone === undefined}{:else if n.alone < 0.05}<span title="Other calls were in flight the whole time: making this one faster saves nothing unless they get faster too"> · always beside other calls</span>
			{:else if n.alone < n.ms - 0.05}<span title="Nothing else was in flight for this long: a faster answer saves at least this. The rest of its time it waited alongside other calls."> · {fmt_ms(n.alone)} ms alone</span>
			{:else}<span title="Nothing else was in flight while it ran: every ms it gets faster, the render does too"> · alone</span>{/if}
		</span>
	{/if}
{/snippet}

{#snippet fills(n: DrillNode)}
	{#if n.fills}
		{@const unread = n.fills.every((f) => !f.read)}
		<!-- what the row was for: the page-data keys its lines feed; all unread = time for nothing -->
		<span class="dr-fills" class:unread title={unread ? 'Every key this feeds is read by nothing on the page: this time buys nothing. Drop it from the load, or move it where it is used.' : 'The page-data keys this feeds (from the load’s return)'}>
			<!-- read keys first; an unread one in a mixed list is marked, its share of the work is waste -->
			→ {#each [...n.fills].sort((a, b) => Number(b.read) - Number(a.read)).slice(0, 5) as f, i (f.key)}{i ? ', ' : ''}<span class:gone={!f.read && !unread} title={f.read ? '' : 'nothing on the page reads this key'}>{f.key}</span>{/each}{n.fills.length > 5 ? ` +${n.fills.length - 5}` : ''}{#if unread}&nbsp;· nothing reads it{/if}
		</span>
	{/if}
{/snippet}

{#snippet split(n: DrillNode)}
	{#if n.split}
		{@const s = n.split}
		{@const per = (ms: number) => fmt_ms(ms / s.calls)}
		<!-- each call's own clock: what the other side claims, the rest until headers, the body -->
		<span class="dr-split" title="Each call's own clock (averaged over its calls): until the answer's headers came, then reading the body. Their side is what the service's own Server-Timing header says it spent; the rest is the network, TLS, their framework or a queue in front of them.">
			{s.calls > 1 ? 'each call' : 'the call'}:
			{#if s.theirs_ms !== undefined}
				<b>{per(s.theirs_ms)} ms their side</b>{#if s.top}&nbsp;({s.top.map((t) => `${t.name} ${per(t.ms)}`).join(', ')}){/if}{#if s.told && s.told < s.calls} on {s.told} of {s.calls}{/if}
				· {per(s.network_ms)} ms network &amp; the rest
			{:else}
				{per(s.network_ms)} ms until headers
			{/if}
			· {per(s.body_ms)} ms body
		</span>
	{/if}
{/snippet}

{#snippet row(n: DrillNode, depth: number)}
	{@const pct = root.ms > 0 ? (n.ms / root.ms) * 100 : 0}
	{#if n.children?.length}
		<details class="d{depth}" open={depth < 1 && n.kind !== 'more'}>
			<summary>
				<span class="dr-bar"><i class="dr-fill {n.kind}" style="width:{Math.max(0.5, pct).toFixed(1)}%"></i></span>
				<span class="dr-ms">{fmt_ms(n.ms)} ms</span>
				<span class="dr-lab">{n.label}</span>
				{@render kind(n)}
				{@render fills(n)}
				{#if n.why}<span class="dr-why">{#each n.why as k (k)}<span title="a slow pattern the report found here">{PATTERN_LABEL[k as PatternKind] ?? k}</span>{/each}</span>{/if}
				{#if n.at && n.kind !== 'line'}<code class="dr-at">{n.at}</code>{/if}
				{@render split(n)}
			</summary>
			<div class="kids">
				{#each n.children as c, i (c.label + '\0' + i)}{@render row(c, depth + 1)}{/each}
			</div>
		</details>
	{:else}
		<div class="leaf d{depth}">
			<span class="dr-bar"><i class="dr-fill {n.kind}" style="width:{Math.max(0.5, pct).toFixed(1)}%"></i></span>
			<span class="dr-ms">{fmt_ms(n.ms)} ms</span>
			{#if n.kind === 'line'}<code class="dr-lab">{n.at ?? n.label}</code>{:else}<span class="dr-lab" class:dim={n.kind === 'more'}>{n.label}</span>{/if}
			{@render kind(n)}
			{@render fills(n)}
			{#if n.why}<span class="dr-why">{#each n.why as k (k)}<span title="a slow pattern the report found here">{PATTERN_LABEL[k as PatternKind] ?? k}</span>{/each}</span>{/if}
			{#if n.at && n.kind !== 'line'}<code class="dr-at">{n.at}</code>{/if}
			{@render split(n)}
		</div>
	{/if}
{/snippet}

<div class="drill">
	<p class="hint">
		One {fmt_ms(root.ms)} ms render, split until it reaches a line: each part of the request, who held its time (your function,
		a library, a call it waited on) and the line to open. A library's time goes to your lines that call it; a wait, to the line that
		made the call; calls waiting at once share the stretch. Every level adds up to the one above.
	</p>
	{#each root.children ?? [] as c, i (c.label + '\0' + i)}{@render row(c, 0)}{/each}
</div>

<style>
	.drill {
		font-size: 13px;
	}
	summary,
	.leaf {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		padding: 3px 0;
	}
	summary {
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	.kids {
		margin-left: 18px;
		border-left: 1px solid var(--line);
		padding-left: 8px;
	}
	.dr-bar {
		flex: 0 0 120px;
		height: 10px;
		background: var(--bg-hover);
		border-radius: 3px;
		overflow: hidden;
	}
	.dr-fill {
		display: block;
		height: 100%;
		background: #4a9d6e;
	}
	.dr-fill.wait {
		background: #3b82f6;
	}
	.dr-fill.gap,
	.dr-fill.more {
		background: var(--text-dim);
		opacity: 0.45;
	}
	.dr-fill.phase {
		background: var(--text);
		opacity: 0.55;
	}
	.dr-ms {
		flex: 0 0 64px;
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.dr-lab {
		flex: 1 1 auto;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	/* a line is a chip that fits its text, not a second bar */
	code.dr-lab {
		flex: 0 1 auto;
		margin-right: auto;
	}
	.d0 > summary .dr-lab {
		font-weight: 600;
	}
	.dr-kind {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-dim);
		white-space: nowrap;
	}
	.dr-at {
		flex: 0 1 auto;
		font-size: 11.5px;
		color: var(--text-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.dim {
		color: var(--text-dim);
	}
	.dr-cold {
		color: #2563eb;
	}
	.dr-fills {
		flex: 0 0 auto;
		font-size: 11.5px;
		color: var(--text-dim);
		font-family: var(--mono, ui-monospace, monospace);
	}
	.dr-fills .gone {
		color: #b45309;
		text-decoration: line-through;
	}
	.dr-fills.unread {
		color: #b45309;
		font-weight: 600;
	}
	/* the call's own clock, on its own line under the row's label */
	.dr-split {
		flex-basis: 100%;
		padding-left: 204px;
		font-size: 11.5px;
		color: var(--text-dim);
		margin-top: -2px;
	}
	.dr-why {
		flex: 0 0 auto;
		display: flex;
		gap: 4px;
	}
	.dr-why > span {
		font-size: 10.5px;
		padding: 0 6px;
		border-radius: 999px;
		background: color-mix(in srgb, #d97706 18%, transparent);
		color: var(--text);
		white-space: nowrap;
	}
</style>
