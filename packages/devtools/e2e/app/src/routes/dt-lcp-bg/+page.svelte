<script lang="ts">
	// THE BACKGROUND-HERO LAB (devtools + profiler): the largest paint is a CSS background image named
	// in a stylesheet answered in 2.6 s, so the browser finds the image only then. The slow LCP's fix
	// must say it is a CSS background (found once the stylesheet is in and the element laid out), not
	// the general "found late" advice; /dt-lcp (an <img>) never says so.
</script>

<svelte:head>
	<link rel="stylesheet" href="/dt-lcp-bg/style.css" />
</svelte:head>

<div class="dt-lcp-bg-hero" role="img" aria-label="hero"></div>
<p>The hero above is a background image its stylesheet names.</p>
