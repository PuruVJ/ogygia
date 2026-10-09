<script lang="ts">
	// THE GOTCHA, on purpose: an island that reads `page.data` (the `$app/state` shim). On the cms's
	// own front door this is the cms page (`site` comes from the cms layout load) — on the server
	// AND after hydrate. Mounted inside the shell, the server render (by cms) still says ACME CMS,
	// but the island hydrates in the SHELL's document, where the same read is the shell's page —
	// so it repaints with whatever the shell has (nothing). ogygia warns about exactly this in dev
	// (`e2e/mfe-foreign-page.spec.ts`). The fix is a prop, not `page`.
	import { page } from '$app/state';
	const site = $derived((page.data as { site?: string }).site ?? '∅');
</script>

<p data-testid="page-data-probe">page.data.site = {site}</p>
