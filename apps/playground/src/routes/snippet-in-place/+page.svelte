<script lang="ts">
	// SNIPPETS RENDER IN PLACE (e2e/snippet-in-place.spec.ts). A zero-arg `{#snippet}` handed to a
	// plain component is branded (it might cross into an island), but where it is rendered in the
	// same tree it must behave as a plain Svelte snippet: the host's context, the host's scoped CSS.
	import { setContext } from 'svelte';
	import RenderSlot from '$lib/snippet-in-place/RenderSlot.svelte';
	import CtxRead from '$lib/snippet-in-place/CtxRead.svelte';
	import InPlaceHost from '$lib/snippet-in-place/InPlaceHost.svelte' with { wake: 'load' };
	setContext('in-place-ctx', 'from-page');
</script>

<h1>Snippets in place</h1>

<div data-host="page">
	<RenderSlot>
		{#snippet content()}
			<CtxRead />
			<b class="probe" data-probe="page">styled by the page</b>
		{/snippet}
	</RenderSlot>
</div>

<div data-host="island"><InPlaceHost /></div>

<style>
	.probe {
		color: rgb(1, 2, 3);
	}
</style>
