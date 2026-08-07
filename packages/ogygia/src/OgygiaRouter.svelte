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
	import { claimRuntimeEmit } from './context.js';

	/** @type {Props} */
	let { viewTransitions = true } = $props();

	// Single runtime bootstrap for the page (islands no longer each emit a copy). Claim so a
	// rare island-before-router layout still dedupes. `asset(runtimeUrl)` matches any island
	// fallback URL. In <head> for early discovery + sticky SPA merge_head retention.
	const LT = String.fromCharCode(60);
	const GT = String.fromCharCode(62);
	const src = asset(runtimeUrl);
	const runtime_script = claimRuntimeEmit()
		? LT +
			'script type="module" data-ogygia-runtime src="' +
			src +
			'"' +
			GT +
			LT +
			'/script' +
			GT +
			(hmrUrl
				? LT +
					'script type="module" data-ogygia-dev-hmr src="' +
					asset(hmrUrl) +
					'"' +
					GT +
					LT +
					'/script' +
					GT
				: '')
		: '';
</script>

<svelte:head>
	<meta name="ogygia-router" content={viewTransitions ? 'vt' : 'plain'} />
	{@html runtime_script}
</svelte:head>
