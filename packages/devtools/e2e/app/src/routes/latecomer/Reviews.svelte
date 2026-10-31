<script lang="ts">
	let { reviews }: { reviews: { name: string; ms: number } } = $props();
	let open = $state(false);
</script>

<section>
	<button onclick={() => (open = !open)}>Reviews ({reviews.name})</button>
	{#if open}<p>Answered in {reviews.ms} ms.</p>{/if}
</section>
