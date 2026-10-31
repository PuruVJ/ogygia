<script lang="ts">
	// A promise `of` (a held region from a remote) — the module SSR cannot see → FAIL-OPEN: the
	// request seeds everything, the lake's call included. The documented conservative side.
	import { Region } from 'ogygia';
	import { boxSearch } from '$lib/box-search.remote';
	import LakeGreeting from '$lib/lakes/LakeGreeting.svelte' with { wake: 'none' };
</script>

<h1>held promise (fail-open)</h1>
<LakeGreeting />
<Region of={boxSearch('gate')}>
	{#snippet placeholder()}<p data-held-placeholder>searching…</p>{/snippet}
</Region>
