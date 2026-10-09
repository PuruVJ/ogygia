<script lang="ts">
	/**
	 * THE BOUNDARY LAB — one page exercising everything that crosses (and what can't).
	 * The host below is csr=false (dead after render); the two islands are separate hydration
	 * roots. Every shared thing crosses the serialization boundary exactly once and reunifies.
	 */
	import { setContext, og_derived } from 'ogygia';
	import LabPanel from '$lib/boundary-lab/LabPanel.svelte' with { wake: 'load' };
	import { LabCart } from '$lib/boundary-lab/cart.svelte';
	import {
		createTally,
		theme as makeTheme,
		doubledOf,
		makeUnprovable,
	} from '$lib/boundary-lab/stores';

	// ── things that CROSS ──────────────────────────────────────────────────────
	const cart = new LabCart(); // og.wire class: session continuity ('lab-cart') + merge
	cart.serverStamp = Date.now() % 1000;
	cart.add('ssr-item');

	const tally = createTally(10); // auto-branded factory — bump() survives the wire
	const themeStore = makeTheme(); // plain writable — auto, shared, live

	const site = 'boundary-lab'; // a local capture for the og.$ fn
	setContext('cart', import.meta.og.$(cart));
	setContext('theme', import.meta.og.$(themeStore));
	setContext('tally', import.meta.og.$(tally));
	setContext(
		'track',
		import.meta.og.$((event: string) => `${site}:${event}`),
	);

	// ── the LIMITATIONS, demonstrated live ────────────────────────────────────
	// 1. a PLAIN derived crosses as a FROZEN seed (the derivation can't travel)…
	setContext('doubled', doubledOf(tally));
	// …but og_derived RESUMES: its recipe (source refs + an og.$ formula) crosses, and islands
	// re-derive against the reunified live source. Bump tally anywhere — this one follows.
	setContext('doubledLive', og_derived(tally, import.meta.og.$((n: number) => n * 2)));
	// 2. an unprovable factory's methods don't survive (generic tier + console warning):
	setContext('rough', makeUnprovable('quiet'));
	// 3. host-only context: never serialized, islands read undefined:
	setContext('hostOnly', { huge: 'server-side config' }, { islands: false });
	// 4. a BARE function can't cross the drop-in path — dropped, dev console explains:
	setContext('logToServer', () => console.log('host-only fn'));

	// ── the ones that would be BUILD ERRORS (uncomment to see file:line) ──────
	// import { OGYGIA_SECRET } from '$env/static/private';
	// setContext('leak', import.meta.og.$(() => OGYGIA_SECRET));      // server-only capture
	// setContext('el', import.meta.og.$({ node: document.body }));    // caught at SSR: DOM never crosses
</script>

<h1>The Boundary Lab</h1>
<p>
	Two islands, separate hydration roots. Everything they share crossed ONE serialization boundary
	and reunified: mutate in either island — the other repaints.
</p>

<LabPanel
	name="A"
	fmt={import.meta.og.$((n: number) => `€${(n / 100).toFixed(2)}`)}
	tally={import.meta.og.$(tally)}
/>
<LabPanel
	name="B"
	fmt={import.meta.og.$((n: number) => `$${(n / 100).toFixed(2)}`)}
	tally={import.meta.og.$(tally)}
/>
