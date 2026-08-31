<script>
	/**
	 * BOUNDARY LAB island. Everything it reads arrived ACROSS the boundary — through context
	 * (the page marker) or props. Two instances of this island prove cross-island liveness:
	 * a write in one repaints the other, because reunification hands both THE SAME instances.
	 */
	import { getContext } from 'svelte';
	// THE RULE THIS DEMONSTRATES: an island must import a wire CLASS as a VALUE so its codec
	// is registered in this bundle — that's how `getContext('cart')` revives to a real LabCart.
	// (Factory stores don't need this when auto-branded from a module the island's graph pulls;
	// here the tally factory rides in via this same import graph.)
	import { LabCart } from './cart.svelte.ts';
	import { createTally } from './stores.ts';
	void LabCart;
	void createTally;

	let { name = 'A', fmt, tally: tallyProp } = $props();

	const cart = getContext('cart');            // og.wire class — methods + $state alive
	const theme = getContext('theme');          // plain writable — shared live
	const tally = getContext('tally');          // auto-branded factory — bump() rebuilt
	const doubled = getContext('doubled');      // LIMITATION: frozen derived seed
	const doubledLive = getContext('doubledLive'); // og_derived: the recipe crossed — RESUMES
	const rough = getContext('rough');          // LIMITATION: generic tier, shout() missing
	const track = getContext('track');          // og.$ fn — bound captures, callable
	const hostOnly = getContext('hostOnly');    // LIMITATION: { islands: false } → undefined here
	const dropped = getContext('logToServer');  // LIMITATION: bare fn → dropped → undefined

	let lastTracked = $state('');
</script>

<section data-lab={name} style="border:1px solid #888;padding:12px;margin:8px">
	<h3>island {name}</h3>

	<p data-cart>cart({cart.count}): {cart.items.join(', ') || '∅'} · server stamp {cart.serverStamp}</p>
	<button data-add onclick={() => cart.add(`${name}${cart.count + 1}`)}>cart.add()</button>

	<p data-theme>theme: {$theme}</p>
	<button data-flip onclick={() => theme.set($theme === 'dark' ? 'light' : 'dark')}>flip theme</button>

	<p data-tally>tally: {$tally}</p>
	<button data-bump onclick={() => tally.bump()}>tally.bump() — factory method, rebuilt</button>

	<p data-fn>fmt(100) via PROP: {fmt(100)} · track: <span data-tracked>{lastTracked}</span></p>
	<button data-track onclick={() => (lastTracked = track(`click:${name}`))}>track() — og.$ context fn</button>

	<p data-prop-tally>tally via PROP is the SAME instance: {$tallyProp === $tally ? 'yes' : 'NO'}</p>

	<h4>limitations, live</h4>
	<p data-doubled>derived (frozen seed): {$doubled} — bump tally; this will NOT follow</p>
	<p data-doubled-live>og_derived (RESUMED): {$doubledLive} — bump tally; this one follows ✓</p>
	<p data-rough>unprovable store: value="{$rough}", shout is {typeof rough.shout} (generic tier — see console warning)</p>
	<p data-host-only>hostOnly key: {String(hostOnly)} (marked islands:false — never serialized)</p>
	<p data-dropped>bare fn key: {String(dropped)} (dropped at the boundary — dev console explains)</p>
</section>
