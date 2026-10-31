<script lang="ts">
	// The innermost island: a counter.
	let { label }: { label: string } = $props();
	let count = $state(0);
</script>

<button data-nest="inner-{label}" onclick={() => (count += 1)}>inner {label} {count}</button>
