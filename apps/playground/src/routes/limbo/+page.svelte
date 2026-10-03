<script lang="ts">
	let { data } = $props();
</script>

<h1>limbo</h1>
<p>{data.count} products; the first: {data.first.brand}, {data.first.dated.join(', ')}, {data.first.sale}, {data.first.spec}.</p>
