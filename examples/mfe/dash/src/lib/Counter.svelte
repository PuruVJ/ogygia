<script lang="ts">
	// DASH-owned interactive island. Hydrates inside the SHELL's page, chunk served from
	// DASH's origin. If the button increments over there, the whole loop works.
	let { start = 0 }: { start?: number } = $props();
	let n = $state(start);
</script>

<button data-testid="dash-counter" onclick={() => n++}>
	dash count: {n}
</button>

<style>
	button {
		background: #0ea5e9;
		color: white;
		border: 0;
		border-radius: 6px;
		padding: 0.5rem 1rem;
		font-size: 1rem;
		cursor: pointer;
	}
</style>
