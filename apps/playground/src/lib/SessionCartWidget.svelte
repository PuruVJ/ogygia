<script lang="ts">
	// Reads the session cart from a prop. The SAME live instance arrives on every page (continuity),
	// so its count + the last user item persist across navigation; serverStamp shows it was a fresh
	// server render that merged into the live object.
	import type { SessionCart } from './session-cart.svelte.js';

	let { cart, page }: { cart: SessionCart; page: string } = $props();
	let n = $state(0);
</script>

<div class="island" data-session-cart data-page={page}>
	<span>page <b data-sc-page>{page}</b></span>
	<span>items <b data-sc-count>{cart.count}</b></span>
	<span>stamp <b data-sc-stamp>{cart.serverStamp}</b></span>
	<span>last <b data-sc-last>{cart.items.at(-1) ?? '-'}</b></span>
	<button data-sc-add onclick={() => cart.add(`${page}-${++n}`)}>add here</button>
</div>
