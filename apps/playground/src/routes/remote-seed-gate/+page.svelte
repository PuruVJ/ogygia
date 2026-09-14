<script lang="ts">
	// REMOTE SEED ONLY WHEN REACHABLE: a lake awaits `getGreeting` for its server render; the only
	// island on the page (Counter) imports no remote module. The page must ship NO
	// `application/ogygia-remote` seed — the lake's result is already HTML, no client can call it.
	// The `/reader` sibling adds an island that CAN call it, and there the seed ships.
	import LakeGreeting from '$lib/lakes/LakeGreeting.svelte' with { wake: 'none' };
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
</script>

<h1>remote seed gate</h1>
<p>A lake that awaits a query, next to an island that calls none.</p>
<LakeGreeting />
<Counter label="no remote here" />
<p><a href="/remote-seed-gate/reader">with a reader island →</a></p>
