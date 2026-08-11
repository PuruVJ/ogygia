<script lang="ts">
	import '$lib/styles/widget.css';
	import { cartCtx } from './cart-store.svelte.js';

	// No prop — the cart comes from the nearest <Context> above, across the island boundary.
	const cart = cartCtx.get();
</script>

<div class="widget" data-ctx-count>
	<span class="widget-label">Count island</span>
	<div class="widget-row">
		<span class="widget-value" data-ctx-count-value>{cart?.count ?? 0}</span>
		<span class="widget-meta">read from context, no prop</span>
	</div>
</div>
