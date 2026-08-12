<script lang="ts">
	// Hydrated island that contains a lake in its own tree (host children can't cross the island
	// boundary, so the lake is imported here, not passed from the page). The lake is frozen; the
	// context reader authored inside it self-hydrates and reads the page provider.
	import CtxLake from '$lib/CtxLake.svelte' with { wake: 'none' };

	let count = $state(0);
</script>

<div class="island" data-ctx-lake-host>
	<button data-lake-host-btn onclick={() => (count += 1)}>host {count}</button>
	<CtxLake />
</div>
