<script lang="ts">
	// THE PAGE OF A RENDER (e2e/page-context.spec.ts): a hole and a region a remote call renders read
	// `page` — data, url, route, params — and must see THIS page, not the request they render in.
	import PageFactsHost from '$lib/pagecontext/PageFactsHost.svelte' with { wake: 'load' };
	import HoleFacts from '$lib/pagecontext/HoleFacts.svelte' with { render: 'deferred' };
	import LocaleBadge from '$lib/pagecontext/LocaleBadge.svelte' with { wake: 'load' };
</script>

<h1>page context</h1>
<LocaleBadge where="page" />
<HoleFacts>
	{#snippet ogygiaFallback()}<p data-pc-hole-fallback>loading the hole…</p>{/snippet}
</HoleFacts>
<PageFactsHost />
