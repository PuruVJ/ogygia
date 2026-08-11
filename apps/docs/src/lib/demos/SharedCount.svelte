<script lang="ts">
	import '$lib/styles/widget.css';
	import type { Cart } from './cart-store.svelte.js';

	let { cart }: { cart: Cart } = $props();
</script>

<div class="widget" data-shared-count>
	<span class="widget-label">Count island</span>
	<div class="widget-row">
		<span class="widget-value" data-shared-count-value>{cart.count}</span>
		<span class="widget-meta">items in the shared cart</span>
	</div>
</div>
