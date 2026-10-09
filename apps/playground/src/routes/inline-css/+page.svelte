<script lang="ts">
	// INLINE REGION CSS under Kit's `inlineStyleThreshold` (playground svelte.config.js sets a small
	// one): the island's small sheet and the hole answer's small sheet ship as
	// `<style data-ogygia-region-css="href">` — no render-blocking request — while a sheet over the
	// threshold keeps its `<link>`. LinkedCssIsland is the CONTROL: identical rules, sheet padded
	// over the threshold, so the same page shows both shapes and e2e/inline-css.spec.ts proves
	// they style identically.
	import InlineCssIsland from '$lib/InlineCssIsland.svelte' with { wake: 'load' };
	import LinkedCssIsland from '$lib/LinkedCssIsland.svelte' with { wake: 'load' };
	import InlineCssHole from '$lib/InlineCssHole.svelte' with { render: 'deferred' };
</script>

<h1 data-page>inline region css</h1>
<InlineCssIsland />
<LinkedCssIsland />
<div data-hole-wrap>
	<InlineCssHole>
		{#snippet ogygiaFallback()}<p data-inline-css-fallback>loading…</p>{/snippet}
	</InlineCssHole>
</div>
