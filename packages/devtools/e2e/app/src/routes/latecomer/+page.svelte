<script lang="ts">
	import Reviews from './Reviews.svelte' with { wake: 'visible' };
	import Price from './Price.svelte' with { wake: 'load' };

	let { data } = $props();
</script>

<h1>{data.title}</h1>
<nav>{data.nav.name} · {data.crumbs.name} · {data.recs.name}</nav>
<Price price={data.price} />
<div style="height: 150vh">(scroll for reviews)</div>
<Reviews reviews={data.reviews} />
