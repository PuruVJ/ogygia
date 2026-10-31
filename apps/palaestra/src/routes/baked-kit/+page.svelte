<script lang="ts">
	// A BAKED held region on a Kit-hydrated page (e2e/baked-kit.spec.ts): a remote query's region passed
	// to `of`, awaited in the render, so its first HTML is baked into the page. Kit's hydration never
	// walks it: it must hydrate without a mismatch, and every island in it must wake on the runtime.
	import { Region } from 'ogygia';
	import { bakedChrome } from '$lib/bakedlab/baked.remote';
</script>

<Region of={bakedChrome()} />
<main><h1 data-bk-page>baked region (kit)</h1></main>
