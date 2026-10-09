<script lang="ts">
	// A `./` sibling island (same directory as the hole) — the second relative form.
	let { label = 'sibling' }: { label?: string } = $props();
	let n = $state(0);
</script>

<button data-nested-sibling onclick={() => (n += 1)}>{label}: <span data-nested-sibling-n>{n}</span></button>
