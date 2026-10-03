<script lang="ts">
	// The devtools answer key's RECOVERED page (internal/bench/devtools-answer-key.mjs): two islands
	// that throw their server DOM away. SameTree draws the same markup back (only Svelte's markers
	// disagreed: no line of its is to blame); DiffTree draws other markup (its own line is the cause).
	import SameTree from '$lib/dtlab/SameTree.svelte' with { wake: 'load' };
	import DiffTree from '$lib/dtlab/DiffTree.svelte' with { wake: 'load' };
</script>

<h1>recovered, two ways</h1>
<SameTree />
<DiffTree />
