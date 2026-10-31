<script lang="ts">
	// THE STREAM LAB (answer key): the load's `reviews` streams (1.2 s), so the document stays open,
	// and both islands wake only after its end — Healthy reads nothing late and waits all the same.
	// Must be named `page.data.reviews`, with both islands. `?quick`: settles in 10 ms, nothing said.
	import Reviews from '$lib/dtstream/Reviews.svelte' with { wake: 'load' };
	import Healthy from '$lib/dtlab/Healthy.svelte' with { wake: 'load' };
</script>

<h1>stream lab</h1>
<Healthy />
<Reviews />
