<script lang="ts">
	let { label = 'inner' }: { label?: string } = $props();
	let n = $state(0);
</script>

<button data-inner onclick={() => (n += 1)}>inner {label}: <span data-inner-n>{n}</span></button>
