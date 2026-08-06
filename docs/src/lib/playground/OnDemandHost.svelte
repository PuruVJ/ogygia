<script lang="ts">
	import type { Component } from 'svelte';
	import '$lib/styles/widget.css';

	// This file is the island (imported with hydrate on the page). The widget below is a plain
	// component — loaded only after click via dynamic import(), then rendered like any child.
	let Lazy = $state<Component | null>(null);
	let loading = $state(false);

	async function load() {
		if (Lazy || loading) return;
		loading = true;
		try {
			Lazy = (await import('$lib/playground/OnDemandWidget.svelte')).default;
		} finally {
			loading = false;
		}
	}
</script>

<div class="widget on-demand-host" data-on-demand-host>
	<span class="widget-label">client-only lazy mount</span>
	<p class="host-lede">
		Host is an island. Click loads a <strong>regular</strong> component with
		<code>await import(…)</code> — no <code>with &#123; hydrate &#125;</code>, no SSR shell for the
		lazy piece.
	</p>
	<button type="button" data-mount-btn onclick={load} disabled={!!Lazy || loading}>
		{Lazy ? 'Component loaded' : loading ? 'Loading…' : 'Load component'}
	</button>

	{#if Lazy}
		{@const Comp = Lazy}
		<div class="host-slot">
			<Comp />
		</div>
	{/if}
</div>

<style>
	.on-demand-host {
		max-width: 420px;
	}
	.host-lede {
		margin: 0 0 1rem;
		font: 400 0.8125rem/1.45 var(--font-body);
		color: var(--text-dim);
	}
	.host-lede code {
		font: 500 0.75rem/1.4 var(--font-mono);
		color: var(--text);
	}
	.host-slot {
		margin-top: 1rem;
	}
</style>
