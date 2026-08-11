<script lang="ts">
	import '$lib/styles/widget.css';
	// `getBadge()` seeds the mounted region; clicking bump runs a COMMAND that mutates server state AND
	// returns the re-rendered region. That response is decoded into a frame write at the SAME address,
	// so the region morphs in place — no follow-up region-endpoint fetch.
	import { onMount } from 'svelte';
	import { Region } from 'ogygia';
	import { getBadge, bumpBadge } from '$lib/demos/single-flight.remote';

	// Prerendered page: create the query in the browser only (a query can't run during prerender SSR).
	let badge = $state<ReturnType<typeof getBadge> | null>(null);
	let busy = $state(false);
	onMount(() => {
		badge = getBadge();
	});

	async function bump() {
		busy = true;
		try {
			await bumpBadge(); // one round trip: mutate + repaint
		} finally {
			busy = false;
		}
	}
</script>

<div class="widget widget--badge" data-single-flight>
	<div class="badge-row">
		<span class="widget-label">server badge</span>
		{#if badge?.current}
			<Region of={badge.current} />
		{:else}
			<span class="widget-meta" data-badge-pending>connecting…</span>
		{/if}
	</div>
	<button type="button" class="badge-bump" onclick={bump} disabled={busy}>bump (one round trip)</button>
	<p class="widget-meta">The command mutates and returns the region in the same response — no second fetch.</p>
</div>

<style>
	.badge-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}
	.badge-bump {
		margin: 0.75rem 0 0.4rem;
		font: 600 0.85rem/1 var(--font-body, sans-serif);
		padding: 0.5rem 0.8rem;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--accent, #4ade80) 55%, var(--line, #333));
		background: color-mix(in srgb, var(--accent, #4ade80) 14%, transparent);
		color: var(--text, #e6eee9);
		cursor: pointer;
	}
	.badge-bump:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
