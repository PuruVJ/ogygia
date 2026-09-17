<script lang="ts">
	// A csr=false page whose island reads the page through a module the csr=true /kit page ALSO
	// imports (`$boot/read-page`, through an app alias). One file, two worlds: the island must get
	// the seeded shim whatever loaded first. e2e/shared-page-module.spec.ts.
	import SharedReader from '$lib/boot/SharedReader.svelte' with { wake: 'load' };
</script>

<nav><a href="/">Home</a> <a href="/kit">Kit page</a></nav>
<h1 data-page>shared page module</h1>
<SharedReader />
