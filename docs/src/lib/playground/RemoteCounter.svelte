<script lang="ts">
	import '$lib/styles/widget.css';

	// query (server state) + command (mutation) + query.refresh(), all from inside the island.
	// Await outside a pending boundary so SSR HTML and the remote seed agree (no pending `…`
	// that hydrates from a seed while a sibling isolate already holds a higher count).
	import { getCount, bump } from '$lib/playground/data.remote';

	const q = getCount();
	// svelte-ignore state_referenced_locally
	const initial = await q;
	let busy = $state(false);

	async function inc() {
		busy = true;
		await bump(1); // command mutates server state
		await q.refresh(); // re-read the query
		busy = false;
	}
</script>

<div class="widget" data-remote-counter>
	<span class="widget-label">command → refresh</span>
	<div class="widget-row">
		<span class="widget-value" data-count>{q.current ?? initial}</span>
		<button type="button" data-bump disabled={busy} onclick={inc}>bump +1</button>
	</div>
	<p class="widget-meta" data-current>reactive .current = {q.current ?? initial}</p>
</div>
