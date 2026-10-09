<script lang="ts">
	// A pending-boundary island (awaits the query INSIDE a boundary → not resolved at SSR) next to
	// the lake. Its closure reaches the module → the lake's call seeds; the island's own call is
	// pending at SSR → omitted, so it fetches after hydration (flicker.spec's "not over-seeded").
	import LakeGreeting from '$lib/lakes/LakeGreeting.svelte' with { wake: 'none' };
	import PendingGreeting from '$lib/PendingGreeting.svelte' with { wake: 'load' };
</script>

<h1>pending island</h1>
<LakeGreeting />
<PendingGreeting name="pending" />
