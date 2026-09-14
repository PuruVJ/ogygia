<script lang="ts">
	import { getGreeting } from '$lib/greetings.remote';
	let { name }: { name: string } = $props();
</script>

<svelte:boundary>
	<p data-lazy-callee>{(await getGreeting(name)).greeting}</p>
	{#snippet pending()}<p>…</p>{/snippet}
</svelte:boundary>
