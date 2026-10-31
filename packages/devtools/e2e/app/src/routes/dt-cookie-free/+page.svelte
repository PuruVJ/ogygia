<script lang="ts">
	let { data } = $props();
</script>

<h1>cookie-free lab</h1>
<ul>
	{#each data.items as item (item)}
		<li>{item}</li>
	{/each}
</ul>
