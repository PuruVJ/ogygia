<script>
	/**
	 * Opt-in SPA router (Astro ClientRouter equivalent). Render this in a layout to
	 * enable client-side navigation + view transitions for that section. Without it,
	 * links are plain MPA document loads.
	 * @typedef {Object} Props
	 * @property {boolean} [viewTransitions=true] use the View Transitions API for swaps
	 */
	import runtimeUrl from 'virtual:ogygia/runtime-url';
	import { asset } from '$app/paths';

	/** @type {Props} */
	let { viewTransitions = true } = $props();

	// Load the runtime module so the router (and its `data-sveltekit-preload-*` prefetch) runs even on
	// a page with NO islands — a hard load of an island-less page would otherwise ship no runtime and
	// have no SPA behaviour. Islands emit the SAME `asset(runtimeUrl)` URL, so browsers dedupe it to a
	// single module evaluation. Built without literal angle brackets so Svelte's raw-text <script>
	// lexer never mistakes them for real tags.
	const LT = String.fromCharCode(60);
	const GT = String.fromCharCode(62);
	const src = asset(runtimeUrl);
	const runtime_script = LT + 'script type="module" src="' + src + '"' + GT + LT + '/script' + GT;
</script>

<svelte:head>
	<meta name="ogygia-router" content={viewTransitions ? 'vt' : 'plain'} />
</svelte:head>

{@html runtime_script}
