<script>
	// A Kit page shell for the lake-under-Kit browser test: a LAKE (the wrapper the transform emits
	// for `with { wake: 'none' }`) with frozen markup and a placed `wake: 'load'` Counter island
	// inside. The test SSRs this on a csr=true document (setup.ts), then hydrates it the way Kit
	// does (`hydrate()` over the SSR DOM) with Kit's bootstrap present.
	import Region from '../../../src/Region.svelte';
	import Counter from './Counter.svelte';
</script>

<div data-shell>
	<p data-shell-text>shell</p>
	<Region __mode="lake" __entry="lake-kit"><p data-frozen>frozen</p><Region
			__mode="island"
			__entry="/test/browser/fixtures/Counter.svelte"
			__component={Counter}
			__props={{ start: 3 }}
		/></Region>
</div>
