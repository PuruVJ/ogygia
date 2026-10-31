<script lang="ts">
	// THE RESTORE LAB's nav pages (e2e/restore.spec.ts): the nav, unpacked by its own runtime on first
	// load, then a router navigation to nav-b, which carries the same nav.
	import NavChrome from '$lib/restorelab/NavChrome.svelte';
</script>

<NavChrome />
<main>
	<h1 data-nav-page="a">nav a</h1>
	<a href="/restore-lab/nav-b" data-nav-go>to b</a>
</main>
