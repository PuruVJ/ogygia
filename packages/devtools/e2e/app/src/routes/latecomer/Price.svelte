<script lang="ts">
	let { price }: { price: { name: string; ms: number } } = $props();
	let qty = $state(1);
</script>

<p>
	<button onclick={() => qty++}>Add one</button>
	{qty} × {price.name}
</p>
