<script lang="ts" module>
	// Throws ONCE, in the browser, during Kit's hydration of the document — and never again. Svelte
	// logs "Failed to hydrate", clears the document and mounts it fresh (the customer shape: a
	// tracking SDK's fetch wrapper threw inside a header's template while Kit was hydrating). The
	// fresh mount runs this again with the fuse blown, so the page comes back — rebuilt in the
	// browser, every server-minted fact on it gone. e2e/hole-kit-rebuild.spec.ts.
	let armed = true;
</script>

<script lang="ts">
	import { browser } from '$app/environment';
	if (browser && armed) {
		armed = false;
		throw new Error('hydration boom (on purpose: Boom.svelte)');
	}
</script>

<p data-boom>boom survived</p>
