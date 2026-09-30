<script lang="ts">
	// THE RESTORE LAB (e2e/restore.spec.ts): the app's server transform (OGYGIA_RESTORE_LAB=1, see
	// hooks.server.ts) renders every <demo-card> / <demo-link> in scoped form. ogygia restores what it
	// moved: the island hydrates without a heal, the hole's answer is restored before it goes in, and
	// the server-owned host below is left for its own runtime.
	import LabCard from '$lib/restorelab/LabCard.svelte' with { wake: 'load' };
	import HoleCard from '$lib/restorelab/HoleCard.svelte' with { render: 'deferred' };
</script>

<h1>restore lab</h1>
<LabCard />
<HoleCard>
	{#snippet ogygiaFallback()}<p data-hole-fallback>loading the hole…</p>{/snippet}
</HoleCard>
<demo-card data-server-card><p>server-owned</p></demo-card>
