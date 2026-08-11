<script lang="ts">
	// Island host for single-flight (csr=false pattern — the binding lives inside a hydrated island,
	// like LivePartials). `getBadge()` seeds the mounted region; clicking bump runs a COMMAND that
	// mutates server state AND returns the re-rendered region. That command response is decoded into a
	// frame write at the SAME address (id|props), so the mounted region morphs in place — no extra fetch.
	import { Region } from 'ogygia';
	import { getBadge, bumpBadge } from '$lib/single-flight.remote';

	const badge = getBadge();
</script>

<div class="single-flight">
	{#if badge.current}
		<Region of={badge.current} />
	{:else}
		<span data-badge-pending>connecting…</span>
	{/if}
	<button data-bump onclick={() => bumpBadge()}>bump</button>
</div>
