<script lang="ts">
	// Lives inside Kept.svelte's `ogygiaFallback`. Marked `wake: 'interaction'` at the import site:
	// zero JS until clicked, then hydrates and the click is replayed — so one click must read k:1.
	let n = $state(0);
</script>

<button data-kept-btn onclick={() => n++}>k:{n}</button>
