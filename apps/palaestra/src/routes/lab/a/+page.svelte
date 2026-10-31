<script lang="ts">
	// A per-page island whose PROPS differ from Page B → different fingerprint → the server DOES
	// re-render it on nav (it shows up in the delta), unlike the kept layout island above.
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
</script>

<h1 data-lab-page>Page A</h1>
<p>
	This heading and the counter below are page-specific, so the delta re-renders them on nav. The blue
	persistent island in the layout above is kept. That contrast IS the server-delta protocol.
</p>
<Counter start={1} label="page-A-counter" />
