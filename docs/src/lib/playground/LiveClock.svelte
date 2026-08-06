<script lang="ts">
	import '$lib/styles/feel.css';
	import '$lib/styles/widget.css';

	// query.live: a streaming server clock over SSE. `.current` updates every tick after hydration.
	import { clock } from '$lib/playground/data.remote';
	const c = clock();
</script>

<div class="widget" data-live-clock>
	<span class="widget-label">query.live · SSE stream</span>
	<svelte:boundary>
		<p class="feel-clock" data-live-value style="margin: 0;">{await c}</p>
		{#snippet pending()}
			<p class="feel-clock" data-live-pending style="margin: 0;">connecting…</p>
		{/snippet}
	</svelte:boundary>
	<p class="widget-meta" data-live-current>latest tick: {c.current ?? '…'}</p>
</div>
