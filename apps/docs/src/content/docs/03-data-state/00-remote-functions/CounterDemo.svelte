<script lang="ts">
	import '$lib/styles/widget.css';
	import { onMount } from 'svelte';
	import { getCount, bump, reset } from '$lib/demos/counter.remote';

	// This doc page is prerendered, so a query cannot run during its SSR. Read it in the browser only
	// (onMount) — the island hydrates, then fetches. `.current` stays put while a call is in flight.
	let c = $state<ReturnType<typeof getCount> | null>(null);
	let busy = $state(false);
	onMount(() => {
		c = getCount();
	});

	async function run(fn: () => Promise<number>) {
		busy = true;
		try {
			await fn(); // command mutates on the server…
			await c?.refresh(); // …then re-read so the value here updates.
		} finally {
			busy = false;
		}
	}
</script>

<div class="widget widget--counter" data-remote-counter>
	<div class="counter-top">
		<span class="widget-label">server count</span>
		<strong class="counter-value" class:is-busy={busy}>{c?.current ?? '—'}</strong>
	</div>
	<div class="counter-actions">
		<button type="button" onclick={() => run(bump)} disabled={busy}>+1 on the server</button>
		<button type="button" class="ghost" onclick={() => run(reset)} disabled={busy}>Reset</button>
	</div>
	<p class="widget-meta">Every click is a real round-trip. Open this page in two tabs — the count is shared.</p>
</div>

<style>
	.counter-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}
	.counter-value {
		font: 700 2rem/1 var(--font-mono, monospace);
		font-variant-numeric: tabular-nums;
		transition: opacity 140ms ease;
	}
	.counter-value.is-busy {
		opacity: 0.5;
	}
	.counter-actions {
		display: flex;
		gap: 0.5rem;
		margin: 0.75rem 0 0.4rem;
	}
	.counter-actions button {
		font: 600 0.85rem/1 var(--font-body, sans-serif);
		padding: 0.5rem 0.8rem;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--accent, #4ade80) 55%, var(--line, #333));
		background: color-mix(in srgb, var(--accent, #4ade80) 14%, transparent);
		color: var(--text, #e6eee9);
		cursor: pointer;
	}
	.counter-actions button.ghost {
		border-color: var(--line, #333);
		background: transparent;
	}
	.counter-actions button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
