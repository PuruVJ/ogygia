<script lang="ts">
	// A placed client island whose CSS (a `:global()` rule) Rollup can chunk-split off the page's
	// static stylesheet. Region.svelte ships the island's own CSS as `<link data-ogygia-region-css>`
	// so it always loads. See e2e/placed-island-css.ts.
	import CssProbe from '$lib/CssProbe.svelte' with { wake: 'load' };
</script>

<h1>placed island css</h1>
<CssProbe />
