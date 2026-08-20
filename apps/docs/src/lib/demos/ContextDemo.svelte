<script lang="ts">
	import { Provide } from 'ogygia';
	import CtxCount from './CtxCount.svelte' with { wake: 'load' };
	import CtxAdd from './CtxAdd.svelte' with { wake: 'load' };
	import { Cart, cartCtx } from './cart-store.svelte.js';

	// One live cart, provided to the subtree. Neither island below receives it as a prop —
	// they call cartCtx.get() and reach this same instance across the island boundary.
	const cart = new Cart();
</script>

<Provide values={[cartCtx(cart)]}>
	<div class="ctx-demo-row">
		<div class="ctx-demo"><CtxCount /></div>
		<div class="ctx-demo"><CtxAdd /></div>
	</div>
</Provide>

<style>
	.ctx-demo-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 1rem;
		margin: 1.5rem 0;
	}
	.ctx-demo {
		padding: 1.25rem;
		border: 1px solid var(--line);
		border-radius: var(--r-md, 12px);
		background: var(--bg-sunken);
	}
</style>
