<script lang="ts">
	// A plain (non-island) component: the spec sheet and the volume price table of one product.
	// Every price goes through `formatPrice` — a new Intl.NumberFormat per cell.
	import type { Product } from './data';
	import { formatPrice } from './util';
	let { product }: { product: Product } = $props();
</script>

<table data-specs>
	<tbody>
		{#each product.specs as s (s.key)}<tr><th>{s.key}</th><td>{s.value} {s.unit}</td></tr>{/each}
	</tbody>
</table>
<table data-prices>
	<thead><tr><th>qty</th><th>unit</th><th>total</th></tr></thead>
	<tbody>
		{#each product.prices as p (p.qty)}
			<tr><td>{p.qty}</td><td>{formatPrice(p.unit, product.currency)}</td><td>{formatPrice(p.total, product.currency)}</td></tr>
		{/each}
	</tbody>
</table>
