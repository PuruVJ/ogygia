<script lang="ts">
	/**
	 * THE SEED EXPLAINER — every top-level `page.data` key, sized, and WHY it ships: read by an
	 * island's client code (the build's answer), referenced by an island's props (a seed reference),
	 * or because some island reads page.data whole. A dropped key shows too, so the shaping is
	 * visible. A finding links here by `#seed=<key>`.
	 */
	import type { SeedRow } from './report-data.js';
	import { fmt_bytes } from './format.js';
	import { row_id, follow_hash } from './row-anchor.svelte.js';

	let { rows, whole_by, total, seed_bytes }: { rows: SeedRow[]; whole_by: string[]; total: number; seed_bytes: number } = $props();
	let picked = $state<string | null>(null);
	const shipped = rows.filter((r) => r.shipped);
	const dropped = rows.filter((r) => !r.shipped);
	const REASON: Record<string, string> = { read: 'read by an island', referenced: 'props point into it', whole: 'an island reads page.data whole' };
	$effect(() => follow_hash('seed', () => rows.map((r) => r.key), (k) => (picked = k)));
</script>

{#if whole_by.length}
	<p class="whole">
		<b>{whole_by.join(', ')}</b> read{whole_by.length === 1 ? 's' : ''} <code>page.data</code> whole, so every key ships. Read the keys by
		name and seed shaping drops the rest.
	</p>
{/if}
<div class="rows">
	{#each rows as r (r.key)}
		<div class="row" id={row_id('seed', r.key)} class:picked={picked === r.key} class:dropped={!r.shipped} onclick={() => (picked = picked === r.key ? null : r.key)} role="button" tabindex="-1">
			<span class="key"><code>{r.key}</code></span>
			<div class="track">
				<div class="fill" class:ref={r.reason === 'referenced'} class:whole={r.reason === 'whole'} style="width:{Math.max(0.5, r.pct)}%"></div>
			</div>
			<span class="num">{fmt_bytes(r.bytes)}</span>
			<span class="why">
				{#if !r.shipped}<span class="chip off">dropped</span>
				{:else}<span class="chip" class:ref={r.reason === 'referenced'} class:whole={r.reason === 'whole'}>{REASON[r.reason ?? ''] ?? 'ships'}</span>{/if}
			</span>
			{#if picked === r.key}
				<div class="detail">
					{#if r.readers_names.length}<div><span class="k">read by</span> {r.readers_names.join(', ')}</div>{/if}
					{#if r.referenced_names.length}<div><span class="k">referenced by the props of</span> {r.referenced_names.join(', ')}</div>{/if}
					{#if !r.readers_names.length && !r.referenced_names.length}
						<div class="hint">{r.shipped ? 'Nothing asks for this key by name: it ships because an island reads page.data whole.' : 'No island reads or references it, so seed shaping left it out of the seed.'}</div>
					{/if}
					{#if r.shipped && r.reason === 'read'}
						<div class="hint">If the island needs only a part, return that part from load under its own key, or pass it as a prop.</div>
					{:else if r.shipped && r.reason === 'referenced'}
						<div class="hint">The cheap shape: the key ships once and the island's props point into it.</div>
					{/if}
				</div>
			{/if}
		</div>
	{/each}
</div>
<p class="hint">
	{shipped.length} of {rows.length} keys ship: {fmt_bytes(seed_bytes)} on the wire{#if dropped.length}, {fmt_bytes(dropped.reduce((s, r) => s + r.bytes, 0))} of {fmt_bytes(total)} left out by seed shaping{/if}. Click a key for who asks for it.
</p>

<style>
	.whole {
		margin: 4px 0 8px;
		padding: 6px 10px;
		background: var(--bg-raised);
		border-left: 3px solid var(--c-orange);
		border-radius: 4px;
		font-size: 12.5px;
	}
	.rows {
		display: grid;
		gap: 3px;
	}
	.row {
		display: grid;
		grid-template-columns: 180px 1fr 80px 200px;
		gap: 10px;
		align-items: center;
		font-size: 12.5px;
		padding: 3px 6px;
		border-radius: 4px;
		cursor: pointer;
	}
	.row:hover,
	.row.picked {
		background: var(--bg-raised);
	}
	.row.dropped {
		opacity: 0.6;
	}
	.key code {
		font-size: 12px;
	}
	.track {
		height: 10px;
		background: var(--bg-hover);
		border-radius: 3px;
		overflow: hidden;
	}
	.fill {
		height: 100%;
		background: var(--c-orange);
	}
	.fill.ref {
		background: var(--c-blue);
	}
	.fill.whole {
		background: var(--warn);
	}
	.dropped .fill {
		background: #3a424e;
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--text-dim);
	}
	.chip {
		font-size: 11px;
		border-radius: 999px;
		padding: 0 8px;
		line-height: 16px;
		border: 1px solid #5a3a2a;
		color: var(--c-orange);
	}
	.chip.ref {
		border-color: #2a3a5a;
		color: var(--c-blue);
	}
	.chip.whole {
		border-color: #5a4a20;
		color: var(--warn);
	}
	.chip.off {
		border-color: var(--line);
		color: var(--text-faint);
	}
	.detail {
		grid-column: 1 / -1;
		padding: 4px 0 4px 8px;
		border-left: 2px solid var(--line);
		display: grid;
		gap: 2px;
	}
	.k {
		color: var(--text-faint);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.hint {
		color: var(--text-faint);
		font-size: 12px;
	}
	@media (max-width: 800px) {
		.row {
			grid-template-columns: 120px 1fr 70px;
		}
		.why {
			grid-column: 1 / -1;
		}
	}
</style>
