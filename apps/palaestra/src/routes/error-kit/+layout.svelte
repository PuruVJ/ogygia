<script lang="ts">
	// Site chrome as a LAKE in a layout whose pages are csr=false but whose ERROR pages Kit hydrates
	// (Kit drops the page node — and its `csr = false` — when it renders `+error.svelte`). The lake
	// must come out in its adoptable form on the 404 and survive Kit's hydration there — before this,
	// a site's header vanished on every 404/500 (customer deploy). e2e/error-kit.spec.ts.
	import LakeChrome from '$lib/lakes/LakeChrome.svelte' with { wake: 'none' };
	let { children } = $props();
</script>

<LakeChrome />
{@render children()}
