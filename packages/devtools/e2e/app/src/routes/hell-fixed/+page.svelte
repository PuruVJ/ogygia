<script lang="ts">
	// HELL, FIXED — /hell's page over lib/hell-fixed (the counted fixes applied; see +page.server.ts).
	import MegaHeader from '$lib/hell-fixed/MegaHeader.svelte' with { wake: 'load' };
	import CountryPanel from '$lib/hell-fixed/CountryPanel.svelte' with { wake: 'none' };
	import SiteSearch from '$lib/hell-fixed/SiteSearch.svelte' with { wake: 'interaction' };
	import PriceTicker from '$lib/hell-fixed/PriceTicker.svelte' with { wake: 'load' };
	import ProductCard from '$lib/hell-fixed/ProductCard.svelte' with { wake: 'visible' };
	import Recommendations from '$lib/hell-fixed/Recommendations.svelte' with { render: 'deferred' };
	// the same hole with a render cache: the profiler's hole economics (hits vs misses)
	import CachedRecommendations from '$lib/hell-fixed/Recommendations.svelte' with { preset: 'cachedRecs' };
	import FooterLake from '$lib/hell-fixed/FooterLake.svelte' with { wake: 'none' };
	import FacetBar from '$lib/hell-fixed/FacetBar.svelte';
	import { header_config, countries, footer_columns } from '$lib/hell-fixed/data';
	import { walkTree } from '$lib/hell-fixed/util';

	let { data } = $props();
	const config = header_config();
	const country_list = countries();
	const footer = footer_columns();
	const suggestions = data.catalog.products.map((p) => p.name);
	const tree = walkTree(data.catalog.taxonomy);
	// "never hand the CMS objects to components": a shallow copy per product per render — which is
	// exactly what defeats the view-model memo keyed by identity in mappers.ts
	const products = data.catalog.products.map((p) => ({ ...p }));
</script>

<svelte:head>
	<title>{data.catalog.title}</title>
	<meta name="description" content="A deliberately overbuilt commerce page for the profiler." />
</svelte:head>

<MegaHeader {config} />
<CountryPanel list={country_list} />
<SiteSearch {suggestions} />

<main data-hell>
	<h1>{data.catalog.title}</h1>
	<p data-static-shell>
		{data.catalog.products.length} products · taxonomy {tree.count} nodes, depth {tree.depth} · session {data.session.ms} ms ·
		db {data.db.rows} rows · manifest {data.manifest} chars · {data.greeting}
	</p>
	<PriceTicker />
	<FacetBar {products} query="compact din breaker family 3" />

	<section class="grid">
		{#each products as p, i (p.id)}
			<ProductCard product={p} position={i} />
		{/each}
	</section>

	<Recommendations forProduct="P0">
		{#snippet ogygiaFallback()}<aside data-recs-fallback>loading recommendations…</aside>{/snippet}
	</Recommendations>
	<CachedRecommendations forProduct="P1">
		{#snippet ogygiaFallback()}<aside data-recs-fallback>loading cached recommendations…</aside>{/snippet}
	</CachedRecommendations>
</main>

<FooterLake columns={footer} />

<style>
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 8px; }
</style>
