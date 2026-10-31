<script lang="ts">
	// THE HEADER LAB (e2e/header-refresh.spec.ts): a header region from a remote query, refreshed by a
	// command after a locale change — it must morph in place: same header, the island's state kept,
	// the hole never back to its fallback.
	import HeaderHost from '$lib/headerlab/HeaderHost.svelte' with { wake: 'load' };
</script>

<HeaderHost />
<main><h1>header refresh</h1></main>
