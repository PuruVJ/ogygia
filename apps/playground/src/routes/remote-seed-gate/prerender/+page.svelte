<script lang="ts">
	import ManifestoLake from '$lib/remote-seed-gate/ManifestoLake.svelte' with { wake: 'none' };
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
</script>

<h1>prerender remote, lake only</h1>
<ManifestoLake />
<Counter label="no remote here" />
