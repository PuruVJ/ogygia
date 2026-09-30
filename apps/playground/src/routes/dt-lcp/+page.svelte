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
</script>

<h1>lcp lab</h1>
<Hero {late} {quick} />
