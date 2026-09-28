<script lang="ts">
	import Reviews from './Reviews.svelte' with { render: 'deferred', wake: 'visible' };
	import Recs from './Recs.svelte' with { render: 'deferred', wake: 'load' };
	import Price from '../latecomer/Price.svelte' with { wake: 'load' };

	let { data } = $props();
</script>

<h1>{data.title}</h1>
<nav>{data.nav.name} · {data.crumbs.name} · <Recs /></nav>
<Price price={data.price} />
<div style="height: 150vh">(scroll for reviews)</div>
<Reviews />
