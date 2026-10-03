<script lang="ts">
	// /dt-bfcache's plant: it saves a draft on 'unload' — the browser then keeps no copy of the page in
	// its back/forward cache.
	let draft = $state('');
	$effect(() => {
		const save = () => sessionStorage.setItem('dt-bf-draft', draft);
		addEventListener('unload', save);
		return () => removeEventListener('unload', save);
	});
</script>

<input class="saver" bind:value={draft} placeholder="a draft saved on unload" />
