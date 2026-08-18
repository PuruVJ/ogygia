<script lang="ts">
	// csr=false host (inherited from the root layout): SplitHeader hydrates as an island here,
	// while /kit renders the SAME file as a plain Kit-hydrated component. Two worlds, one file.
	import SplitHeader from '$lib/split-brain/SplitHeader.svelte' with { wake: 'load' };
</script>

<nav><a href="/">Home</a> <a href="/kit">Kit page</a></nav>
<hr />
<h1 data-static-shell>split-brain regression (csr = false)</h1>
<SplitHeader />
