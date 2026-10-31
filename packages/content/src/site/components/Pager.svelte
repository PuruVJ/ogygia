<script lang="ts">
	/**
	 * Sequential previous/next — a pure function of a `PageView`'s trail (outline reading order).
	 * A lone next stays right; `.og-pager` hooks for CSS.
	 */
	import type { PageView } from '../types.js';

	let {
		trail,
		previousLabel = 'Previous',
		nextLabel = 'Next'
	}: {
		trail: Pick<PageView['trail'], 'prev' | 'next'>;
		previousLabel?: string;
		nextLabel?: string;
	} = $props();
</script>

{#if trail.prev || trail.next}
	<nav class="og-pager" aria-label="Previous and next page">
		{#if trail.prev}
			<a class="og-pager-link og-pager-prev" href={trail.prev.href} rel="prev">
				<span class="og-pager-dir">{previousLabel}</span>
				<span class="og-pager-title">{trail.prev.title}</span>
			</a>
		{:else}
			<span></span>
		{/if}
		{#if trail.next}
			<a class="og-pager-link og-pager-next" href={trail.next.href} rel="next">
				<span class="og-pager-dir">{nextLabel}</span>
				<span class="og-pager-title">{trail.next.title}</span>
			</a>
		{/if}
	</nav>
{/if}
