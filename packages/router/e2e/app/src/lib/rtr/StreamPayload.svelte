<script lang="ts">
	// The LATE yield of a streamed page — carries its OWN island: the bake emits the region
	// shell, and when the chunk swaps into the live DOM the custom element connects and wakes
	// on its own (no orchestration; the whole point of self-waking islands).
	import StreamTally from './StreamTally.svelte' with { wake: 'load' };
	let { data }: { data: { title: string } } = $props();
</script>

<section data-stream-payload>
	<h2>{data.title}</h2>
	<StreamTally />
</section>
