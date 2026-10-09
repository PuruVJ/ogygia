<script lang="ts">
	// THE LCP LAB (devtools answer key). Plain: the hero image is in the server HTML, and its download
	// (2.6 s) is most of the largest paint. `?late`: the island adds the image only after it wakes, so
	// the browser begins fetching it late — the delay before the fetch is the plant then. Both must be
	// named on the hero island, with the part that cost most.
	import { page } from '$app/state';
	import Hero from '$lib/dtlcp/Hero.svelte' with { wake: 'load' };
	const late = page.url.searchParams.has('late');
	// `?quick`: the same hero answered in 300 ms — the fast twin "since your last profile" compares
	const quick = page.url.searchParams.has('quick');
	// `?lazy`: the hero carries loading="lazy" (the plant); a lazy image far below is the decoy
	const lazy = page.url.searchParams.has('lazy');
	// `?below`: two ~350 KB images far below the first screen, not lazy: they download beside the
	// slow hero (the plant: named as what the hero's download shared the network with)
	const below = page.url.searchParams.has('below');
</script>

<h1>lcp lab</h1>
<Hero {late} {quick} {lazy} />
{#if below}
	<div style="height: 3000px"></div>
	<img src="/dt-img/right.png?la" width="400" height="300" alt="planted: below, eager" />
	<img src="/dt-img/right.png?lb" width="400" height="300" alt="planted: below, eager" />
{/if}
