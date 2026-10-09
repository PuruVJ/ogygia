<script lang="ts">
	// The SHELL's own island — corporate chrome with state. Proves two teams' islands
	// coexist on one page under ONE runtime (the shell's).
	// SHELL READS what team B writes: cross-BUILD reactive state, no subscription code.
	import { cart } from '@corp/contracts';
	let open = $state(false);
	const cart_count = $derived(cart.current.items.length);
</script>

<nav class="chrome">
	<strong>ACME Suite</strong>
	<span data-testid="cart-badge">🛒 {cart_count}</span>
	<button data-testid="shell-menu" onclick={() => (open = !open)}>
		account {open ? '▲' : '▼'}
	</button>
	{#if open}
		<span data-testid="shell-menu-open">signed in as puru</span>
	{/if}
</nav>

<style>
	.chrome {
		display: flex;
		gap: 1rem;
		align-items: center;
		background: #111827;
		color: white;
		padding: 0.6rem 1rem;
		border-radius: 8px;
		font-family: system-ui, sans-serif;
	}
	button {
		background: #374151;
		color: white;
		border: 0;
		border-radius: 6px;
		padding: 0.3rem 0.8rem;
		cursor: pointer;
	}
</style>
