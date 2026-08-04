<script lang="ts">
	// A LAKE (used with `hydrate: 'false'` inside a hydrated island). Its code ships in NO client
	// chunk — the island's client module swaps this import for a placeholder. SSR renders it inline;
	// the runtime lifts/restores its DOM around the parent hydrate. Its own button is INERT (frozen,
	// no JS). It contains an island-in-lake (InnerLive) which DOES self-hydrate.
	import InnerLive from './InnerLive.svelte' with { hydrate: 'load' };

	// Distinctive string the lakes suite greps for — it must appear in NO emitted client chunk.
	const FROZEN_MARKER = 'FROZEN_LAKE_CODE_MARKER_9f3a';
	let frozen = $state(0);
</script>

<div class="lake" data-frozen-box>
	<p data-frozen-static>frozen SSR content ({FROZEN_MARKER})</p>
	<button data-frozen-btn onclick={() => (frozen += 1)}>frozen button: {frozen} (inert — no JS)</button>
	<InnerLive />
</div>
