<script lang="ts">
	import '$lib/styles/widget.css';
	import { cartCtx } from './cart-store.svelte.js';

	const cart = cartCtx.get();
	let n = $state(0);
</script>

<div class="widget" data-ctx-add>
	<span class="widget-label">Add island</span>
	<div class="widget-row">
		<button type="button" onclick={() => cart?.add(`item ${++n}`)}>Add to cart</button>
	</div>
	<p class="widget-meta">separate bundle, same context</p>
</div>
