<script lang="ts">
	// One search result, rendered 120 times per page. The comment on each line says which slow
	// pattern the profiler should name (or, for a DECOY, why it should stay quiet).
	import type { ProductView } from './catalog';
	import { tr, specList, brandOf } from './catalog';
	import { BRANDS } from './data';
	import { formatMoney, relTime, newestReview, pct } from './format';

	let { p, rank }: { p: ProductView; rank: number } = $props();

	// PATTERN table-per-call: a fixed icon table rebuilt for every card (belongs in <script module>)
	const ICONS = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`i${i}`, `M${i} ${i}l${i % 7} ${i % 11}z`]));

	// PATTERN sort-per-call: all 400 brands sorted again on every card, to show the first three
	const nearby = [...BRANDS].sort((a, b) => (a.country === p.brand?.country ? 0 : 1) - (b.country === p.brand?.country ? 0 : 1) || a.id - b.id).slice(0, 3);
	const top = [...p.reviews].sort((a, b) => b.stars - a.stars).slice(0, 2);

	const price = formatMoney(p.price, p.currency);
	const updated = relTime(p.updated);
	const newest = newestReview(p.reviews);
	const label = tr(`ui.key.${rank * 7}`);
	// DECOY: a Map lookup per card is fine
	const brand = brandOf(p.brandId);
	// DECOY: every spec is needed, so walking all of them is right
	const specs = specList(p.specs).slice(0, 3);
	const avg = p.reviews.reduce((s, r) => s + r.stars, 0) / p.reviews.length;
</script>

<article class="card">
	<svg viewBox="0 0 24 24" width="16" height="16"><path d={ICONS[`i${rank % 400}`]} /></svg>
	<h3>{p.name}</h3>
	<p class="meta">{brand?.name ?? '—'} · {label} · updated {updated} · newest review {new Date(newest).toISOString().slice(0, 10)}</p>
	<p class="price">{price} <small>{pct(avg / 5)} liked it</small></p>
	<ul>
		{#each top as r, i (i)}<li>{'★'.repeat(r.stars)} {r.body}</li>{/each}
	</ul>
	<p class="specs">{specs.join(' · ')} · also from {nearby.map((b) => b.name).join(', ')}</p>
</article>

<style>
	.card {
		border: 1px solid #ddd;
		border-radius: 8px;
		padding: 10px 12px;
		font: 14px/1.4 system-ui, sans-serif;
	}
	h3 {
		margin: 0 0 4px;
		font-size: 15px;
	}
	.meta,
	.specs {
		color: #666;
		font-size: 12px;
		margin: 2px 0;
	}
	.price {
		font-weight: 600;
		margin: 4px 0;
	}
	ul {
		margin: 4px 0;
		padding-left: 18px;
		font-size: 12px;
	}
</style>
