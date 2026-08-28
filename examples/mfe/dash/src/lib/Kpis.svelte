<script lang="ts">
	// The FRAGMENT ROOT the dash team exports. Its own scoped styles must travel to the shell;
	// the islands inside carry dash's wake dials (load + visible) — the shell has no say.
	import Counter from './Counter.svelte' with { wake: 'load' };
	import AddToCart from './AddToCart.svelte' with { wake: 'load' };
	import Ticker from './Ticker.svelte' with { wake: 'visible' };

	let { org, viewer = null }: {
		org: string;
		viewer?: { sub?: string; roles?: string[] } | null;
	} = $props();
	// the visitor's claims arrived signature-bound through the fragment hop (on-behalf-of)
	const is_admin = $derived(viewer?.roles?.includes('admin') ?? false);
	// pretend server work — this ran on DASH's server at stitch time
	const kpis = [
		{ label: 'MRR', value: '$41.2k' },
		{ label: 'Churn', value: '1.9%' },
		{ label: 'Seats', value: '312' }
	];
</script>

<section class="kpis" data-testid="dash-fragment">
	<h2>Dashboard · {org}</h2>
	<div class="grid">
		{#if is_admin}
			<div class="card" data-testid="admin-kpi">
				<span class="label">Margin (admin)</span>
				<span class="value">31%</span>
			</div>
		{/if}
		{#each kpis as k (k.label)}
			<div class="card">
				<span class="label">{k.label}</span>
				<span class="value">{k.value}</span>
			</div>
		{/each}
	</div>
	<p class="row">
		<Counter start={40} />
		<Ticker />
		<AddToCart sku="odace-switch" />
	</p>
</section>

<style>
	.kpis {
		border: 2px solid #0ea5e9;
		border-radius: 10px;
		padding: 1rem;
		font-family: system-ui, sans-serif;
	}
	.kpis h2 {
		margin: 0 0 0.75rem;
		color: #0369a1;
	}
	.grid {
		display: flex;
		gap: 0.75rem;
	}
	.card {
		background: #f0f9ff;
		border-radius: 8px;
		padding: 0.75rem 1rem;
		display: flex;
		flex-direction: column;
	}
	.label {
		font-size: 0.75rem;
		color: #64748b;
		text-transform: uppercase;
	}
	.value {
		font-size: 1.4rem;
		font-weight: 700;
		color: #0c4a6e;
	}
	.row {
		display: flex;
		gap: 1rem;
		align-items: center;
		margin: 0.9rem 0 0;
	}
</style>
