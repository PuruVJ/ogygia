<script lang="ts">
	// An interactive island B, authored by the PAGE inside island A's children. It must render and
	// become interactive (nested-island degrade: hydrates with A).
	let { start = 0 }: { start?: number } = $props();
	// svelte-ignore state_referenced_locally
	let n = $state(start);
</script>

<button class="island" data-bumper onclick={() => (n += 1)}>bump <span data-bumper-n>{n}</span></button>
