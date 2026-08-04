<script lang="ts">
	// Alternation: shell -> island (LakeCounter) -> lake (FrozenBox) -> island-in-lake (InnerLive).
	import LakeCounter from '$lib/lakes/LakeCounter.svelte' with { hydrate: 'load' };
	import FrozenBox from '$lib/lakes/FrozenBox.svelte' with { hydrate: 'none' };
</script>

<h1 data-static-shell>Lakes — frozen regions inside a hydrated island</h1>
<p data-static-shell>
	The island counter is interactive. The lake below it is frozen: its button never increments (its
	JS ships in no client chunk), yet the island NESTED inside the lake self-hydrates and works.
</p>

<LakeCounter>
	<FrozenBox />
</LakeCounter>
