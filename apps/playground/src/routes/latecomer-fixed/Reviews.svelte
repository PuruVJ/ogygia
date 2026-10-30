<script lang="ts">
	import { getReviews } from '#lib/latecomer.remote.ts';
	const reviews = await getReviews();
	let open = $state(false);
</script>

<section>
	<button onclick={() => (open = !open)}>Reviews ({reviews.name})</button>
	{#if open}<p>Answered in {reviews.ms} ms.</p>{/if}
</section>
