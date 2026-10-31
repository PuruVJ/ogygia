<script lang="ts">
	// Nesting for the devtools: island › lake › island, open from the server (a) and appearing only
	// after a click (b). Every tab must see all of them, with the right kind and hydration state.
	import NestOuter from '$lib/dtnest/NestOuter.svelte' with { wake: 'load' };
	import NestLake from '$lib/dtnest/NestLake.svelte' with { wake: 'none' };
	import NestInner from '$lib/dtnest/NestInner.svelte' with { wake: 'load' };
</script>

<h1>nesting lab</h1>
<NestOuter name="a" open={true}>
	<NestLake><NestInner label="a" /></NestLake>
</NestOuter>
<NestOuter name="b">
	<NestLake><NestInner label="b" /></NestLake>
</NestOuter>
