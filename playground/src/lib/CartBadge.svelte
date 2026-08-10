<script lang="ts">
	// Island B. Only reads the shared cart. Separate bundle from AddCartButton.
	// If the plain module is shared, this count tracks clicks in the OTHER island.
	import { cart } from './cart.svelte.js';
</script>

<div class="island" data-cart-badge>
	Cart: <strong data-cart-count>{cart.count}</strong>
</div>
