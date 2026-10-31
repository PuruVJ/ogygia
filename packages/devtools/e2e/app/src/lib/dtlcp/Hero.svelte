<script lang="ts">
	// The LCP lab's hero, an island: its image is the page's largest paint. `late`: the image is only
	// added by the island after it wakes (a script-shown hero, found late by the browser).
	// `quick`: the image in the HTML, answered in 300 ms (the fast twin the profiler compares against)
	// `lazy`: the hero carries loading="lazy" — the browser holds its fetch until layout says it is on
	// screen (the plant: the largest paint should never be lazy)
	let { late = false, quick = false, lazy = false }: { late?: boolean; quick?: boolean; lazy?: boolean } = $props();
	let shown = $state(!late);
	$effect(() => {
		if (late) setTimeout(() => (shown = true), 2600);
	});
	let n = $state(0);
</script>

<div data-lcp-hero>
	<!-- (late: a quick image, so the wait before its fetch is the cost, not its download) -->
	{#if shown}<img src={late || quick || lazy ? '/dt-lcp/hero.svg?quick' : '/dt-lcp/hero.svg'} alt="hero" width="1200" height="600" loading={lazy ? 'lazy' : undefined} />{/if}
	<!-- (decoy: a lazy image far below the first screen — exactly what lazy is for) -->
	{#if lazy}<img src="/dt-lcp/hero.svg?quick&below" alt="below" width="300" height="150" loading="lazy" style="margin-top: 3000px; display: block" />{/if}
	<button data-lcp-like onclick={() => n++}>like {n}</button>
</div>
