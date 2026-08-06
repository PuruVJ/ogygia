<script lang="ts">
	import '$lib/styles/widget.css';

	// query (server state) + command (mutation) + query.refresh(), all from inside the island.
	import { getCount, bump } from '$lib/playground/data.remote';

	const count = getCount();
	let busy = $state(false);

	async function inc() {
		busy = true;
		await bump(1); // command mutates server state
		await count.refresh(); // re-read the query
		busy = false;
	}
</script>

<div class="widget" data-remote-counter>
	<span class="widget-label">command → refresh</span>
	<div class="widget-row">
		<svelte:boundary>
			<span class="widget-value" data-count>{await count}</span>
			{#snippet pending()}<span class="widget-value" data-count-pending>…</span>{/snippet}
		</svelte:boundary>
		<button type="button" data-bump disabled={busy} onclick={inc}>bump +1</button>
	</div>
	<p class="widget-meta" data-current>reactive .current = {count.current ?? '…'}</p>
</div>
