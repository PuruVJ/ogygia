<script lang="ts">
	// THE HERO REPAINT LAB for the devtools answer key: HeroSwap holds the largest paint and renders
	// it by another branch in the browser (the heading is replaced as it wakes) — lcp-repaint names it.
	// /dt-big is the decoy: there the largest paint's island only changes an attribute elsewhere.
	import HeroSwap from '$lib/dtbig/HeroSwap.svelte' with { wake: 'load' };
</script>

<HeroSwap />
<p>Below the hero.</p>
