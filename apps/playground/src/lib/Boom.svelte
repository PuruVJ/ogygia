<script lang="ts">
	// The block a foreign post-SSR pass corrupts (hooks.server.ts, on /hole-kit-rebuild only): it
	// strips this `{#if}`'s hydration marker from the served HTML — the customer shape, a web-component
	// renderer or a proxy rewriting markup after the render. Hydrating Kit's document then hits a
	// mismatch Svelte cannot repair in place: it drops the server DOM and mounts the document fresh,
	// in the browser, every server-minted fact on it gone. e2e/hole-kit-rebuild.spec.ts.
	const alive = true;
</script>

<p data-boom>{#if alive}boom survived{/if}</p>
