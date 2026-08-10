<script lang="ts">
	// SWR shell: the shell timestamp advances across requests (revalidated in the background),
	// while still being served from cache (instant). The defer hole streams fresh each request.
	import PprHole from '$lib/PprHole.svelte' with { fill: 'load' };

	const shell_rendered_at = new Date().getTime();
</script>

<nav><a href="/">Home</a></nav>
<hr />
<h1 data-static-shell>PPR (swr) proof</h1>
<p data-static-shell>
	shell rendered at <strong data-shell-time>{shell_rendered_at}</strong>
</p>

<PprHole>
	{#snippet ogygiaFallback()}
		<span data-hole-fallback>loading hole…</span>
	{/snippet}
</PprHole>
