<script lang="ts">
	// A `visible` island far below the fold. Its code must not download until it scrolls into view
	// (e2e/visible-below.spec.ts): the `'load'` preload policy's promise, "nothing downloads before
	// there is a reason to".
	import Counter from '$lib/Counter.svelte' with { wake: 'visible' };
</script>

<h1 data-page>a visible island below the fold</h1>
<div style="height: 4000px" data-spacer>scroll…</div>
<div data-below>
	<Counter start={3} />
</div>
