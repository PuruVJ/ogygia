<script lang="ts">
	// A KEPT island: its live node and $state survive SPA navigation (props pushed fresh from the
	// incoming page's sidecar — which now sits at the end of the body).
	let { page = '?' }: { page?: string } = $props();
	let clicks = $state(0);
</script>

<div data-keeper>
	<span data-keeper-page>{page}</span>
	<button data-keeper-btn onclick={() => (clicks += 1)}>clicks {clicks}</button>
</div>
