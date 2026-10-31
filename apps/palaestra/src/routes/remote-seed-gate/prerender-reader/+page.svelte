<script lang="ts">
	import ManifestoLake from '$lib/remote-seed-gate/ManifestoLake.svelte' with { wake: 'none' };
	import ManifestoReader from '$lib/remote-seed-gate/ManifestoReader.svelte' with { wake: 'load' };
</script>

<h1>prerender remote, with a reader island</h1>
<ManifestoLake />
<ManifestoReader />
