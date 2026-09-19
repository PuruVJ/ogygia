<script lang="ts">
	// One product card island (wake: 'visible' at the page): takes the WHOLE product as its prop —
	// a page.data node, so it crosses as a seed reference — renders the tokenized description, the
	// spec + price tables, a JSON-LD block, and a nested Rating island. An
	// IntersectionObserverPolyfill (a PascalCase class) is built per card on the server, the way a
	// tracking helper would be.
	import type { Product } from './data';
	import { tokenize, jsonLd, IntersectionObserverPolyfill, formatPrice } from './util';
	import SpecTable from './SpecTable.svelte';
	import Rating from './Rating.svelte' with { wake: 'load' };
	let { product, position }: { product: Product; position: number } = $props();
	let inCart = $state(0);
	const observer = new IntersectionObserverPolyfill(`card-${position}`);
	observer.observe(product.id);
	const html = tokenize(product.description);
	const ld = jsonLd(product);
</script>

<article data-product={product.id} data-track={observer.summary()}>
	<header>
		<h3>{product.name} <small>{product.sku}</small></h3>
		<Rating value={product.rating} />
	</header>
	<p class="summary">{product.summary}</p>
	<div class="desc">{@html html}</div>
	<p class="price"><b>{formatPrice(product.price, product.currency)}</b> · {product.stock} in stock · {product.tags.join(', ')}</p>
	<SpecTable {product} />
	<ul class="docs">{#each product.docs as d (d.href)}<li><a href={d.href}>{d.title}</a> ({Math.round(d.bytes / 1024)} KB)</li>{/each}</ul>
	<button onclick={() => (inCart += 1)}>add to cart ({inCart})</button>
	<div hidden data-ld={ld}></div>
</article>

<style>
	article { border: 1px solid #e5e5e5; padding: 12px; margin: 8px 0; }
	.desc :global(em) { color: #444; }
</style>
