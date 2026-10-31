<script lang="ts">
	// STREAMED LOAD DATA, ogygia-style: the load hands this page a PROMISE of a region; the
	// region owns the wait (placeholder), and on a streamed router document the resolution rides
	// the initial response as a late chunk — no client refetch (e2e/stream-page.ts).
	import { Region } from 'ogygia';
	let { data }: { data: { pending: Promise<unknown> } } = $props();
</script>

<h1>late-region page</h1>
<Region of={data.pending as never}>
	{#snippet placeholder()}<div data-region-skeleton>crunching the slow part…</div>{/snippet}
</Region>
