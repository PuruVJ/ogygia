<script lang="ts">
	// A BAKED held region's content, shaped like a site header rendered by a remote query: no single
	// root element (so the render's own block markers sit at its top level), a `load` island, an `idle`
	// island shown only when the server says the visitor is signed in, and a hole.
	import { page } from '$app/state';
	import LoadCounter from './BakedCounter.svelte' with { wake: 'load' };
	import IdleCounter from './BakedCounter.svelte' with { wake: 'idle' };
	import BakedHole from './BakedHole.svelte' with { render: 'deferred' };
	const signed_in = (page.data as { signedIn?: boolean }).signedIn === true;
</script>

<p data-bk-title>chrome</p>
<LoadCounter name="load" />
{#if signed_in}
	<IdleCounter name="idle" />
{/if}
<BakedHole>
	{#snippet ogygiaFallback()}<span data-bk-hole-fallback>…</span>{/snippet}
</BakedHole>
