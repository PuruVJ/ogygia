<script lang="ts">
	// A csr=false page with one deferred hole. With the `og-auth-wall` cookie set, the playground's
	// auth-wall handle (hooks.server.ts) takes the hole's request away from ogygia.handle() — a 302
	// to /hole-wall/account/, or a whole document — and the runtime must keep the fallback instead
	// of swapping that page in. e2e/hole-wall.spec.ts.
	import Greeting from '$lib/Greeting.svelte' with { render: 'deferred' };
</script>

<h1 data-page>hole behind an auth wall</h1>
<Greeting salutation="Hello">
	{#snippet ogygiaFallback()}<p data-wall-fallback>loading greeting…</p>{/snippet}
</Greeting>
