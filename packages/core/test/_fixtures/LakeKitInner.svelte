<script>
	// What a lake wraps in the lake-under-Kit suite: frozen markup plus a placed `wake: 'load'`
	// island (the wrapper the transform would emit for `import Tiny … with { wake: 'load' }`).
	import Region from '../../src/Region.svelte';
	import Tiny from './Tiny.svelte';
</script>

<p data-inner>frozen inside</p>
<Region __mode="island" __entry="/islands/tiny.js" __component={Tiny} __props={{}} />
