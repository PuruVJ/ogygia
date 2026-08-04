<script>
	import { clock } from '$lib/greetings.remote';
	const c = clock();
</script>

<svelte:boundary>
	<div class="island" data-live-clock>live server time: <span data-live-value>{await c}</span></div>
	{#snippet pending()}
		<div class="island" data-live-pending>connecting to live clock…</div>
	{/snippet}
</svelte:boundary>

<!-- reactive current (updates each stream tick after hydration) -->
<div class="island" data-live-current>latest tick: {c.current}</div>
