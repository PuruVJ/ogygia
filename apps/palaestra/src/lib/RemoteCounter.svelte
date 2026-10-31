<script lang="ts">
	// query (server state) + command (mutation) + query.refresh(), all client-side.
	import { getCount, bump } from '$lib/greetings.remote';
	const count = getCount();
	let busy = $state(false);
	async function inc() {
		busy = true;
		await bump(1); // command -> mutates server state
		await count.refresh(); // re-fetch the query -> reactive .current updates
		busy = false;
	}
</script>

<div class="island" data-remote-counter>
	<svelte:boundary>
		<span data-count>server count (SSR + hydration): {await count}</span>
		{#snippet pending()}<span data-count-pending>loading count…</span>{/snippet}
	</svelte:boundary>
	<div data-current>reactive current: {count.current}</div>
	<button data-bump disabled={busy} onclick={inc}>bump +1 (command → refresh)</button>
</div>
