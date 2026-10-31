<script lang="ts">
	// THE SCROLL-JANK LAB for the devtools answer key. Janky's scroll handler works 120 ms per event
	// (the plant); Calm's reads once per frame (the decoy). Only Janky's handler is named.
	import Janky from '$lib/dtjank/Janky.svelte' with { wake: 'load' };
	import Calm from '$lib/dtjank/Calm.svelte' with { wake: 'load' };
</script>

<h1>scroll jank lab</h1>
<Janky />
<Calm />
<div style="height: 4000px; background: linear-gradient(#eee, #ccc)"></div>
