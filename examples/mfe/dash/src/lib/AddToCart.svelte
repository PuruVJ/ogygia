<script lang="ts">
	// TEAM B writes: one line, no bus, no emit — mutate the shared value.
	import { cart } from '@corp/contracts';
	let { sku }: { sku: string } = $props();
</script>

<button data-testid="add-to-cart" onclick={() => cart.current.items.push(sku)}>
	add {sku} to cart
</button>

<style>
	button { background: #16a34a; color: white; border: 0; border-radius: 6px; padding: 0.5rem 1rem; cursor: pointer; }
</style>
