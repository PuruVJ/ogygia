<script lang="ts">
	// A plain component a remote call renders as a region (no `wake`: HTML only), with an island inside
	// that reads the page on the client.
	import FactsCard from './FactsCard.svelte';
	import LocaleBadge from './LocaleBadge.svelte' with { wake: 'load' };
</script>

<FactsCard kind="remote" />
<LocaleBadge where="inside" />
