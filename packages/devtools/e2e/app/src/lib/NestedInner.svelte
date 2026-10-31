<script lang="ts">
	// The nested wake island inside NestedHole (a deferred hole). Its click must be live after the
	// hole's HTML lands — proof the nested island hydrated on the far side.
	let { label = 'inner' }: { label?: string } = $props();
	let n = $state(0);
</script>

<button data-nested-inner onclick={() => (n += 1)}>{label}: <span data-nested-inner-n>{n}</span></button>
