<script>
	// A page shell placing the SAME wake island twice (the wrapper the transform emits for
	// `import Tiny … with { wake: 'load' }`) — the kit-island-stamp suite renders it on a csr=true
	// route (inline under Kit) and on a csr=false one (real regions).
	import Region from '../../src/Region.svelte';
	import Tiny from './Tiny.svelte';
</script>

<div data-shell>
	<Region __mode="island" __entry="/islands/tiny.js" __component={Tiny} __props={{}} />
	<Region __mode="island" __entry="/islands/tiny.js" __component={Tiny} __props={{}} />
</div>
