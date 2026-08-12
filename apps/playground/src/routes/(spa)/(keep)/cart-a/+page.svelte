<script lang="ts">
	// Continuity demo: each page builds a FRESH server SessionCart (new instance, fresh stamp). The
	// named codec reunites the client with the ONE live session cart, so the cart follows across SPA
	// navigations while each page's server stamp merges in.
	import SessionCartWidget from '$lib/SessionCartWidget.svelte' with { wake: 'load' };
	import { SessionCart } from '$lib/session-cart.svelte.js';
	import { next_stamp } from '$lib/lakes/stamp.js';

	const cart = new SessionCart([], next_stamp());
</script>

<h1 data-static-shell>Cart page a</h1>
<a href="/cart-a" data-to-a>go A</a> <a href="/cart-b" data-to-b>go B</a>
<SessionCartWidget {cart} page="a" />
