<script lang="ts">
	// THE HEADER LAB on a Kit-hydrated page (e2e/header-refresh.spec.ts): the header region from a remote
	// query passed STRAIGHT to `of` — a promise — in a csr=true page, refreshed by a command.
	import { Region } from 'ogygia';
	import { invalidateAll } from '$app/navigation';
	import { headerRegion, switchHeaderLocale } from '$lib/headerlab/header.remote';
</script>

<Region of={headerRegion()}>
	{#snippet placeholder()}<p data-hl-placeholder>loading the header…</p>{/snippet}
</Region>
<button data-hl-switch onclick={async () => (await switchHeaderLocale('fr'), await invalidateAll())}>français</button>
<main><h1>header refresh (kit)</h1></main>
