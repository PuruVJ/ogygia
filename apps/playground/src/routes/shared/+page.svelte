<script lang="ts">
	// Two SEPARATE island bundles that import one plain state module.
	// Probe: does clicking Add in one island update the badge in the other?
	import AddCartButton from '$lib/AddCartButton.svelte' with { wake: 'load' };
	import CartBadge from '$lib/CartBadge.svelte' with { wake: 'load' };
</script>

<nav><a href="/">Home</a></nav>
<hr />
<h1 data-static-shell>Shared state probe</h1>
<p data-static-shell>Two separate islands, one plain <code>cart.svelte.ts</code> module.</p>

<CartBadge />
<AddCartButton />
