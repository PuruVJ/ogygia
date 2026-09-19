<script lang="ts">
	// A NESTED island (inside ProductCard): the star widget. Renders inline with its parent.
	let { value }: { value: number } = $props();
	let voted = $state(false);
</script>

<span data-rating>{'★'.repeat(Math.round(value))}{'☆'.repeat(5 - Math.round(value))} {value.toFixed(1)}
	<button onclick={() => (voted = !voted)}>{voted ? 'voted' : 'vote'}</button></span>
