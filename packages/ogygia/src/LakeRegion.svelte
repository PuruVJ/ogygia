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
	import { isNested } from './context.js';

	/**
	 * @typedef {Object} Props
	 * @property {string} __entry lake region id
	 * @property {'cache'|'empty'|'swr'} [__remount]
	 * @property {string} [__when] revalidate schedule (only when __remount === 'swr')
	 * @property {number} [__maxAge] client lake-cache TTL in ms
	 * @property {'empty'|'fetch'} [__onExpire] past maxAge: blank or skip-stale fetch (swr)
	 * @property {string} [__margin] IntersectionObserver rootMargin for `__when: 'visible'`
	 * @property {Record<string, unknown>} [__props] captured props, re-rendered by the endpoint
	 * @property {import('svelte').Snippet} [children] the authored lake tag / inner component
	 */

	/** @type {Props} */
	let {
		__entry,
		__remount = 'cache',
		__when = 'load',
		__maxAge,
		__onExpire,
		__margin,
		__props = {},
		children
	} = $props();

	// Shell use (not inside a hydrated island): lakes are a no-op — render children as a plain
	// component. Only meaningful inside an island (freeze + lift/restore).
	const inside = isNested();

	const swr = $derived(__remount === 'swr');
	// SSR mints the capability URL; the CLIENT stub returns '' (it has no secret), so this attribute
	// is dropped when Svelte hydrates the island — the runtime captures it BEFORE hydration instead.
	const endpoint = $derived(inside && swr ? makeRegionEndpoint(__entry, __props) : '');
</script>

{#if inside}
	<ogygia-region
		entry={__entry}
		hydrate="none"
		remount={__remount}
		when={swr ? __when : undefined}
		max-age={__maxAge != null ? String(__maxAge) : undefined}
		on-expire={__onExpire || undefined}
		margin={swr && __margin ? __margin : undefined}
		endpoint={endpoint || undefined}
	>
		<LakeBoundary>{@render children?.()}</LakeBoundary>
	</ogygia-region>
{:else}
	{@render children?.()}
{/if}
