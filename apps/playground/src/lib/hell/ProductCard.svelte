<script lang="ts">
	// One product card island (wake: 'visible' at the page): takes the WHOLE product as its prop —
	// a page.data node, so it crosses as a seed reference. On the server it maps the DTO to a view
	// model (a structuredClone + a markdown render + the spec/price mappers — the memo never hits,
	// the page hands it a fresh copy), tracks itself, i18n's its labels, and renders the design
	// system's Button/Icon per document, a nested Rating island, a JSON-LD block, and an
	// IntersectionObserverPolyfill (a PascalCase class) per card.
	import type { Product } from './data';
	import { jsonLd, IntersectionObserverPolyfill, formatPrice } from './util';
	import { toProductVM } from './mappers';
	import { t } from './i18n';
	import { track } from './track';
	import SpecTable from './SpecTable.svelte';
	import Button from './ds/Button.svelte';
	import Badge from './ds/Badge.svelte';
	import Rating from './Rating.svelte' with { wake: 'load' };
	let { product, position }: { product: Product; position: number } = $props();
	let inCart = $state(0);
	const observer = new IntersectionObserverPolyfill(`card-${position}`);
	observer.observe(product.id);
	const vm = toProductVM(product);
	const ld = jsonLd(product);
	track('product.card', { id: vm.id, position, tags: vm.tags });
</script>

<article data-product={vm.id} data-track={observer.summary()}>
	<header>
		<h3>{vm.title}</h3>
		{#each vm.tags as tag (tag)}<Badge label={tag} tone={tag === 'din' ? 'info' : 'neutral'} />{/each}
		<!-- the design system's web components: rendered on the server by its hydrate package, given
		     behaviour in the browser by its CDN script -->
		<ion-chip color={vm.stock > 20 ? 'success' : 'warning'}>{vm.stock > 20 ? 'in stock' : 'low stock'}</ion-chip>
		<ion-badge color="primary">{vm.sku}</ion-badge>
		<Rating value={vm.rating} />
	</header>
	<p class="summary">{@html vm.summaryHtml}</p>
	<div class="desc">{@html vm.descriptionHtml}</div>
	<p class="price"><b>{t('price.from', { price: formatPrice(vm.price, vm.currency) })}</b> · {t('product.in_stock', { n: vm.stock })}</p>
	<SpecTable specs={vm.specs} prices={vm.prices} />
	<h4>{t('product.docs')}</h4>
	<ul class="docs">
		{#each vm.docs as d (d.href)}
			<li><Button href={d.href} icon={d.icon} size="sm">{d.title} ({d.kb} KB)</Button></li>
		{/each}
	</ul>
	<button onclick={() => (inCart += 1)}>{t('product.add', { n: inCart })}</button>
	<ion-button size="small" fill="outline" href="/p/{vm.id}">details</ion-button>
	<div hidden data-ld={ld}></div>
</article>

<style>
	article { border: 1px solid #ddd; padding: 12px; }
	.desc { max-height: 6em; overflow: hidden; }
	.docs { display: flex; flex-wrap: wrap; gap: 4px; list-style: none; padding: 0; }
</style>
