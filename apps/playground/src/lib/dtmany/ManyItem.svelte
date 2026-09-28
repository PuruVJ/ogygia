<script lang="ts">
	// One of many small islands: a counter with a label.
	let { n }: { n: number } = $props();
	let count = $state(0);
</script>

<button class="many" data-many={n} onclick={() => (count += 1)}>item {n} · {count}</button>
