<script lang="ts">
	// A server island with tiny scoped CSS: its hole answer carries the sheet INLINE, and the runtime
	// hoists that `style[data-ogygia-region-css]` tag into the head before the swap — e2e/inline-css.spec.ts.
	import type { Snippet } from 'svelte';
	let { ogygiaFallback }: { ogygiaFallback?: Snippet } = $props();
</script>

<p class="inline-css-hole" data-inline-css-hole>served with inline css</p>

<style>
	.inline-css-hole {
		word-spacing: 5px;
		outline: 2px dotted rgb(51, 34, 17);
	}
</style>
