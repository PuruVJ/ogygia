<script lang="ts">
	// Prerendered (PPR) page with an swr lake inside a hydrated island. LakeCounter's `swr` face
	// mints a signed revalidate endpoint at BUILD time — the capability rides the static file.
	import LakeCounter from '$lib/lakes/LakeCounter.svelte' with { wake: 'load' };
</script>

<nav><a href="/">Home</a></nav>
<hr />
<h1 data-static-shell>Prerendered swr lake</h1>

<div data-static-lake>
	<LakeCounter swr />
</div>
