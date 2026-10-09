<script lang="ts">
	// THE LEFTOVERS LAB for the devtools answer key: Ticker starts an interval and a window listener
	// it never takes back; Tidy takes its own back. After an in-app navigation to /dt-leak-next, only
	// Ticker is named — and again after a navigation back here (its new copy is not the one that left).
	import Ticker from '$lib/dtleak/Ticker.svelte' with { wake: 'load' };
	import Tidy from '$lib/dtleak/Tidy.svelte' with { wake: 'load' };
</script>

<h1>leftovers lab</h1>
<Ticker />
<Tidy />
<a data-leak-go href="/dt-leak-next">next</a>
