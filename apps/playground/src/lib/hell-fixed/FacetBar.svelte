<script lang="ts">
	// A plain (non-island) component above the grid: facet counts (computeFacets → groupBy →
	// facetKey → normalizeKey) and a "related to your search" strip (rankProducts → score →
	// similarity), each value a design-system Badge, each heading i18n'd, the whole thing tracked.
	import type { Product } from './data';
	import { computeFacets, rankProducts } from './util';
	import { t } from './i18n';
	import { track } from './track';
	import Badge from './ds/Badge.svelte';
	import Icon from './ds/Icon.svelte';
	let { products, query }: { products: Product[]; query: string } = $props();
	const facets = computeFacets(products);
	const related = rankProducts(products, query);
	track('facets.render', { dims: facets.length, related: related.length });
</script>

<nav data-facets>
	{#each facets as f (f.dim)}
		<div class="facet">
			<h4><Icon name="filter" /> {f.dim}</h4>
			<ul>{#each f.values.slice(0, 8) as v (v.key)}<li><a href="?{f.dim}={v.key}"><Badge label={v.key} count={v.count} /></a></li>{/each}</ul>
		</div>
	{/each}
</nav>
<aside data-related>
	<h4>Related to “{query}” <ion-badge color="tertiary">{related.length}</ion-badge></h4>
	<ol>{#each related as r (r.product.id)}<li><a href="/p/{r.product.id}">{r.product.name}</a> <small>{Math.round(r.score * 100)}%</small></li>{/each}</ol>
</aside>

<style>
	nav { display: flex; gap: 16px; flex-wrap: wrap; }
	.facet ul { list-style: none; padding: 0; }
</style>
