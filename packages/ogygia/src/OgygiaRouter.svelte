<script>
	/**
	 * Opt-in SPA router (Astro `ClientRouter` equivalent).
	 *
	 * Render once in a layout to enable client-side navigation and optional view
	 * transitions for that section. Without it, same-origin links are normal MPA
	 * document loads. Also ensures the ogygia runtime module loads on pages that
	 * have no islands (so prefetch / SPA still work).
	 *
	 * @component
	 * @example
	 * In `src/routes/+layout.svelte`: import `{ OgygiaRouter }` from `ogygia`, render
	 * `<OgygiaRouter />` once, then `{@render children()}`.
	 *
	 * @typedef {Object} Props
	 * @property {boolean} [viewTransitions=true] Use the View Transitions API when swapping documents.
	 */
	import runtimeUrl from 'virtual:ogygia/runtime-url';
	import hmrUrl from 'virtual:ogygia/dev-hmr-url';
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
	const runtime_script =
		LT +
		'script type="module" data-ogygia-runtime src="' +
		src +
		'"' +
		GT +
		LT +
		'/script' +
		GT;

	// Dev CSS HMR bridge. `hmrUrl` is '' outside `vite dev` (virtual module is mode-aware).
	const hmr_script = hmrUrl
		? LT +
			'script type="module" data-ogygia-dev-hmr src="' +
			asset(hmrUrl) +
			'"' +
			GT +
			LT +
			'/script' +
			GT
		: '';
</script>

<svelte:head>
	<meta name="ogygia-router" content={viewTransitions ? 'vt' : 'plain'} />
</svelte:head>

{@html runtime_script}{@html hmr_script}
