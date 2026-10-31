<script lang="ts">
	// The island HOST that drives the live header. `render: 'live'` is a revalidating LAKE:
	// baked into the page bytes (no fallback flash), zero client JS of its own, and its host
	// island re-fetches a fresh SERVER render (with the visitor's cookies) and swaps it in.
	import BigHeader from '$lib/BigHeader.svelte' with { render: 'live', wake: 'load' };
</script>

<BigHeader />
