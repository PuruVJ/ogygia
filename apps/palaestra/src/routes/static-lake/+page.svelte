<script lang="ts">
	// Prerendered (PPR) page with an swr lake inside a hydrated island. LakeCounter's `swr` face
	// mints a signed revalidate endpoint at BUILD time — the capability rides the static file.
	// `base` keeps the link correct (and prerender-clean) under a non-root `paths.base`; `''` by default.
	import LakeCounter from '$lib/lakes/LakeCounter.svelte' with { wake: 'load' };
	import { base } from '$app/paths';
</script>

<nav><a href="{base}/">Home</a></nav>
<hr />
<h1 data-static-shell>Prerendered swr lake</h1>

<div data-static-lake>
	<LakeCounter swr />
</div>
