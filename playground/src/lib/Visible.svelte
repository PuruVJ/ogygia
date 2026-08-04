<script>
	let { note = '' } = $props();
	let clicks = $state(0);
	// Runs only after client-side hydration.
	if (typeof window !== 'undefined') {
		console.log('[sk-islands] visible island hydrated:', note);
	}
</script>

<div class="island" data-visible-island>
	Below-the-fold <strong>visible</strong> island hydrated. {note}
	<button onclick={() => (clicks += 1)}>clicked {clicks}</button>
</div>
