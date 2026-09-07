<script lang="ts">
	// A csr=false LAYOUT whose chrome is a LAKE, serving a csr=false page (/lake-kit) AND a csr=true
	// page (/lake-kit/kit, Kit hydrates the whole document there). The lake must survive Kit's
	// hydration and the island + hole inside it must keep working on both — e2e/lake-kit.spec.ts.
	import LakeChrome from '$lib/lakes/LakeChrome.svelte' with { wake: 'none' };
	let { children } = $props();
</script>

<LakeChrome />
{@render children()}
