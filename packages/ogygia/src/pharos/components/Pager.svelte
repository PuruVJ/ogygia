<script lang="ts">
	/**
	 * Sequential previous/next — a pure function of a `DocView`'s trail (outline reading order).
	 * A lone next stays right; `.ph-pager` hooks for CSS.
	 */
	import type { DocView } from '../types.js';

	let {
		trail,
		previousLabel = 'Previous',
		nextLabel = 'Next'
	}: {
		trail: Pick<DocView['trail'], 'prev' | 'next'>;
		previousLabel?: string;
		nextLabel?: string;
	} = $props();
</script>

{#if trail.prev || trail.next}
	<nav class="ph-pager" aria-label="Previous and next page">
		{#if trail.prev}
			<a class="ph-pager-link ph-pager-prev" href={trail.prev.href} rel="prev">
				<span class="ph-pager-dir">{previousLabel}</span>
				<span class="ph-pager-title">{trail.prev.title}</span>
			</a>
		{:else}
			<span></span>
		{/if}
		{#if trail.next}
			<a class="ph-pager-link ph-pager-next" href={trail.next.href} rel="next">
				<span class="ph-pager-dir">{nextLabel}</span>
				<span class="ph-pager-title">{trail.next.title}</span>
			</a>
		{/if}
	</nav>
{/if}
