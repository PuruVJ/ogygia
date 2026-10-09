<script lang="ts">
	// The stream lab's reader: shows page.data.reviews when it settles (a streamed promise).
	import { page } from '$app/state';
	const reviews = () => (page.data as { reviews?: Promise<string[]> }).reviews;
</script>

<div data-stream-reviews>
	{#await reviews()}
		<span>reviews: loading</span>
	{:then list}
		<span data-stream-done>reviews: {list?.join(', ')}</span>
	{/await}
</div>
