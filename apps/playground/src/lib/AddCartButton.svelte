<script lang="ts">
	// Island A. Writes to the shared cart. Separate bundle from CartBadge.
	import { cart } from './cart.svelte.js';
	let n = $state(0);
</script>

<div class="island" data-add-cart>
	<button onclick={() => cart.add(`item-${++n}`)}>Add to cart</button>
	<span data-local-count>added here: {n}</span>
</div>
