<script lang="ts">
	// THE HOLE QUEUE for the devtools answer key: five deferred holes on the first screen, each
	// awaiting 0.9 s. The server renders four at a time: the fifth waits for a slot. See QueueHole.svelte.
	import QueueHole from '$lib/dtholes/QueueHole.svelte' with { render: 'deferred' };
</script>

<h1>hole queue lab</h1>
{#each [1, 2, 3, 4, 5] as n (n)}
	<QueueHole {n}>
		{#snippet ogygiaFallback()}<p data-hole="queue-{n}">loading queued hole {n}…</p>{/snippet}
	</QueueHole>
{/each}
