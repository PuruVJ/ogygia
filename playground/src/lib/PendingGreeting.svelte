<script>
	import { getGreeting } from '$lib/greetings.remote';
	let { name } = $props();
</script>

<svelte:boundary>
	<div class="island" data-pending-greeting>
		<strong>Resolved after hydration:</strong> {(await getGreeting(name)).greeting}
	</div>
	{#snippet pending()}
		<div class="island" data-pending>Loading greeting… (SSR renders this pending snippet)</div>
	{/snippet}
</svelte:boundary>
