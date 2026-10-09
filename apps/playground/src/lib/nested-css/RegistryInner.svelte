<script lang="ts">
	let { label = 'registry inner' }: { label?: string } = $props();
</script>

<!-- A nested island reached through a REGISTRY at render time (a CMS block inside a CMS container
     island): never in the outer island's own imports (e2e/nested-css). -->
<p class="nc-registry" data-nc-registry>{label}</p>

<style>
	.nc-registry {
		--og-nc-token: nctoken-registry;
		outline: 2px solid rgb(9, 176, 84);
	}
</style>
