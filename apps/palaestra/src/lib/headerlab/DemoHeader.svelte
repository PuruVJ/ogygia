<script lang="ts">
	// THE HEADER LAB's header (e2e/header-refresh.spec.ts): HTML only (a plain import, no `wake`), with
	// an island and a hole inside that wake themselves. A remote query renders it as a region; a
	// command saves the locale and refreshes the query, and the mounted header morphs in place.
	import { page } from '$app/state';
	import NavCounter from './NavCounter.svelte' with { wake: 'load' };
	import AccountHole from './AccountHole.svelte' with { render: 'deferred' };
	const locale = (page.data as { locale?: string }).locale ?? '';
</script>

<header data-hl-header data-locale={locale}>
	<span data-hl-title>{locale === 'fr' ? 'Bonjour' : 'Hello'}</span>
	<NavCounter />
	<AccountHole>
		{#snippet ogygiaFallback()}<span data-hl-account-fallback>…</span>{/snippet}
	</AccountHole>
</header>
