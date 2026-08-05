<script lang="ts">
	// Alternation: shell -> island (LakeCounter) -> lake (FrozenBox) -> island-in-lake (InnerLive).
	// Remount policy lives on presets (U1): default cache; frozenSwr paints stale then re-fetches.
	import LakeCounter from '$lib/lakes/LakeCounter.svelte' with { hydrate: 'load' };
	import FrozenBox from '$lib/lakes/FrozenBox.svelte' with { hydrate: 'none' };
	import FrozenSwr from '$lib/lakes/FrozenBox.svelte' with { preset: 'frozenSwr' };
</script>

<h1 data-static-shell>Lakes — frozen regions inside a hydrated island</h1>
<p data-static-shell>
	The island counter is interactive. The lake below it is frozen: its button never increments (its
	JS ships in no client chunk), yet the island NESTED inside the lake self-hydrates and works.
	Toggle removes/re-adds the lake; default remount is <code>cache</code>.
</p>

<LakeCounter>
	<FrozenBox />
</LakeCounter>

<h2 data-static-shell>remount: swr</h2>
<p data-static-shell>
	Same lake via <code>preset: 'frozenSwr'</code>. Toggle off/on paints cached HTML then fetches a
	fresh SSR of the lake from the region endpoint.
</p>
<div data-swr-demo>
	<LakeCounter>
		<FrozenSwr />
	</LakeCounter>
</div>
