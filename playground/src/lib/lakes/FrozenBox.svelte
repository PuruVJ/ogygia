<script lang="ts">
	// A frozen region (used with `wake: 'none'` inside a waking region). Its code ships in NO
	// client chunk — the parent's client module swaps this import for a placeholder. SSR renders it
	// inline; the runtime lifts/restores its DOM around the parent hydrate. Its own button is INERT
	// (frozen, no JS). It contains a region-in-freeze (InnerLive) which DOES self-hydrate.
	import InnerLive from './InnerLive.svelte' with { wake: 'load' };
	import { next_stamp } from './stamp.js';

	// Distinctive string the lakes suite greps for — it must appear in NO emitted client chunk.
	const FROZEN_MARKER = 'FROZEN_LAKE_CODE_MARKER_9f3a';
	let {
		label = '',
		children
	}: { label?: string; children?: import('svelte').Snippet } = $props();
	let frozen = $state(0);
	// Increments per SERVER render, so a `render: 'live'` revalidate is visibly newer than the cache.
	const stamp = next_stamp();
</script>

<div class="lake" data-frozen-box>
	<p data-frozen-static>frozen SSR content ({FROZEN_MARKER})</p>
	<p data-frozen-stamp={stamp}>server render #{stamp}</p>
	{#if label}<p data-frozen-label>{label}</p>{/if}
	<button data-frozen-btn onclick={() => (frozen += 1)}>frozen button: {frozen} (inert — no JS)</button>
	<InnerLive />
	{@render children?.()}
</div>
