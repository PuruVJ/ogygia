<script lang="ts">
	// A plain (non-island) component: the spec sheet and the volume price table of one product,
	// already mapped by the card's view model. It still i18n's each label through `t()` (a catalog
	// scan per call) and tracks itself.
	import { t } from './i18n';
	import { track } from './track';
	let { specs, prices }: { specs: { label: string; text: string }[]; prices: { qty: number; unit: string; total: string; sym: string }[] } = $props();
	track('product.specs', { rows: specs.length + prices.length });
</script>

<table data-specs>
	<tbody>
		{#each specs as s (s.label)}<tr><th>{t('spec.label', { label: s.label })}</th><td>{s.text}</td></tr>{/each}
	</tbody>
</table>
<table data-prices>
	<thead><tr><th>qty</th><th>unit</th><th>total</th></tr></thead>
	<tbody>
		{#each prices as p (p.qty)}
			<tr><td>{p.qty}</td><td>{p.unit}</td><td>{p.total} <small>{p.sym}</small></td></tr>
		{/each}
	</tbody>
</table>
