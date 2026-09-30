<script lang="ts">
	// The LCP lab's hero, an island: its image is the page's largest paint. `late`: the image is only
	// added by the island after it wakes (a script-shown hero, found late by the browser).
	// `quick`: the image in the HTML, answered in 300 ms (the fast twin the profiler compares against)
	let { late = false, quick = false }: { late?: boolean; quick?: boolean } = $props();
	let shown = $state(!late);
	$effect(() => {
		if (late) setTimeout(() => (shown = true), 2600);
	});
	let n = $state(0);
</script>

<div data-lcp-hero>
	<!-- (late: a quick image, so the wait before its fetch is the cost, not its download) -->
	{#if shown}<img src={late || quick ? '/dt-lcp/hero.svg?quick' : '/dt-lcp/hero.svg'} alt="hero" width="1200" height="600" />{/if}
	<button data-lcp-like onclick={() => n++}>like {n}</button>
</div>
