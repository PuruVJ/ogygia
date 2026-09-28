<script lang="ts">
	// /inferno-deals: the deals list over the load's formatted rows (see +page.server.ts).
	let { data } = $props();
</script>

<h1>Deals · {data.title}</h1>
<ul>
	{#each data.deals as d (d.id)}
		<li>{d.name}: <b>{d.price}</b> <s>{d.was}</s> · {d.badge} · updated {d.updated}</li>
	{/each}
</ul>
