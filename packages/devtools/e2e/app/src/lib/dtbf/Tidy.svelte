<script lang="ts">
	// /dt-bfcache's decoy: the same save on 'pagehide' — the back/forward cache keeps the page.
	let draft = $state('');
	$effect(() => {
		const save = () => sessionStorage.setItem('dt-bf-tidy', draft);
		addEventListener('pagehide', save);
		return () => removeEventListener('pagehide', save);
	});
</script>

<input class="tidy" bind:value={draft} placeholder="a draft saved on pagehide" />
