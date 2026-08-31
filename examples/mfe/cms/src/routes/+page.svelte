<script lang="ts">
	// The cms app's Kit-side index. ALSO load-bearing: an app whose every page is
	// router-rendered emits NO og-runtime chunk (v2 gap, noted in mfe.md) — this one
	// Kit page with a marked island forces the client build + runtime emission.
	import LikeButton from '$lib/LikeButton.svelte' with { wake: 'load' };
</script>

<main style="font-family: system-ui; max-width: 640px; margin: 2rem auto">
	<h1>mfe-cms</h1>
	<p>This app's real pages live under <a href="/cms/">/cms/</a> (programmatic router).</p>
	<LikeButton post="index" />
</main>
