<script>
	// A page shell holding a LAKE (the wrapper the transform emits for `with { wake: 'none' }`).
	import Region from '../../src/Region.svelte';
	import LakeKitInner from './LakeKitInner.svelte';
	let { entry = 'lake-1' } = $props();
</script>

<div data-shell><Region __mode="lake" __entry={entry}><LakeKitInner /></Region></div>
