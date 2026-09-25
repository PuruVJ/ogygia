<script lang="ts">
	// An ISLAND whose markup hands a snippet to a plain component — the snippet must render in the
	// island's own tree (its context, its scoped CSS) on the server AND after hydration.
	import { setContext } from 'svelte';
	import RenderSlot from './RenderSlot.svelte';
	import CtxRead from './CtxRead.svelte';
	setContext('in-place-ctx', 'from-island');
	let n = $state(0);
</script>

<section data-in-place-island>
	<button data-in-place-btn onclick={() => n++}>clicks {n}</button>
	<RenderSlot>
		{#snippet content()}
			<CtxRead />
			<b class="probe" data-probe="island">styled by the island</b>
		{/snippet}
	</RenderSlot>
</section>

<style>
	.probe {
		color: rgb(10, 20, 30);
	}
</style>
