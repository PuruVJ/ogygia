<script lang="ts">
	import '$lib/styles/widget.css';
	import type { Cart } from './cart-store.svelte.js';

	let { cart }: { cart: Cart } = $props();
	let n = $state(0);
</script>

<div class="widget" data-shared-add>
	<span class="widget-label">Add island</span>
	<div class="widget-row">
		<button type="button" onclick={() => cart.add(`item ${++n}`)}>Add to cart</button>
	</div>
	<p class="widget-meta">separate bundle from the count</p>
</div>
