<script lang="ts">
	// THE NAVIGATION LAB (devtools answer key): from here to /dt-nav-slow is a planted slow in-app
	// navigation (its load waits 800 ms); back here is the decoy, fast. Only the slow one is named.
</script>

<h1 data-nav-page="fast">fast page</h1>
<a data-nav-go="slow" href="/dt-nav-slow">to the slow page</a>
<!-- the same, prefetched on hover: a hover before the click starts the fetch early -->
<a data-nav-go="slow-hover" data-sveltekit-preload-data="hover" href="/dt-nav-slow">to the slow page, prefetched</a>
