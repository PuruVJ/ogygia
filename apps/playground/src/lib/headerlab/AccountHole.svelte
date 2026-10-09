<script lang="ts">
	// A hole in the header: rendered per visitor in the islands endpoint, for this page.
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	let {}: { ogygiaFallback?: Snippet } = $props();
	const locale = (page.data as { locale?: string }).locale ?? '';
</script>

<span data-hl-account data-locale={locale}>{locale === 'fr' ? 'Mon compte' : 'My account'}</span>
