<script lang="ts">
	// This component is used as an island, and its OWN source imports other components as
	// islands. Both inner islands degrade to normal components that hydrate with this one.
	import Inner from '$lib/Inner.svelte' with { hydrate: 'visible' };
	// A SERVER island nested inside a client island degrades too: it renders inline as a
	// normal component ('server' strategy ignored), so its data still appears.
	import Greeting from '$lib/Greeting.svelte' with { defer: 'load' };

	let { title = 'outer' }: { title?: string } = $props();
	let m = $state(0);
</script>

<div class="island" data-outer>
	<button data-outer-btn onclick={() => (m += 1)}>outer {title}: <span data-outer-m>{m}</span></button>
	<Inner label="child" />
	<div data-nested-server><Greeting salutation="Hey" /></div>
</div>
