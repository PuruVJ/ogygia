<script>
	// Private wrapper the transform emits AROUND a `hydrate: 'none'` usage inside an island.
	// Renders SSR HTML inline (furniture); optional remount:'swr' mints a signed endpoint for
	// stale-while-revalidate on {#if} remount. NOT part of the public API.
	//
	// The lake itself arrives as `children` — the transform wraps the authored tag instead of
	// re-creating it, so the lake keeps its own attributes/children AND stays a static component
	// reference (a dynamic `<Component />` here would add a `<!--[-->…<!--]-->` envelope inside the
	// region that the runtime's lift/restore carries away, breaking hydration — LAKE-ENVELOPE).
	import { makeRegionEndpoint } from 'virtual:ogygia/region-endpoint';
	import LakeBoundary from './LakeBoundary.svelte';

	/**
	 * @typedef {Object} Props
	 * @property {string} __entry lake region id
	 * @property {'cache'|'empty'|'swr'} [__remount]
	 * @property {string} [__when] SWR revalidate schedule (only when __remount === 'swr')
	 * @property {string} [__margin] IntersectionObserver rootMargin for `__when: 'visible'`
	 * @property {Record<string, unknown>} [__props] captured props, re-rendered by the endpoint
	 * @property {import('svelte').Snippet} [children] the authored lake tag
	 */

	/** @type {Props} */
	let {
		__entry,
		__remount = 'cache',
		__when = 'load',
		__margin,
		__props = {},
		children
	} = $props();

	const swr = $derived(__remount === 'swr');
	// SSR mints the capability URL; the CLIENT stub returns '' (it has no secret), so this attribute
	// is dropped when Svelte hydrates the island — the runtime captures it BEFORE hydration instead.
	const endpoint = $derived(swr ? makeRegionEndpoint(__entry, __props) : '');
</script>

<ogygia-region
	entry={__entry}
	hydrate="none"
	remount={__remount}
	when={swr ? __when : undefined}
	margin={swr && __margin ? __margin : undefined}
	endpoint={endpoint || undefined}
>
	<LakeBoundary>{@render children?.()}</LakeBoundary>
</ogygia-region>
