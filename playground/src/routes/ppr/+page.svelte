<script lang="ts">
	// PPR proof route. The shell stamps its render time in `data-shell-time`. If ogygia caches +
	// replays the shell, that timestamp FREEZES across requests. The `defer` server island below
	// (the hole) stamps its own time server-side each request, so `data-hole-time` CHANGES — proving
	// the shell is cached while the hole streams fresh.
	import PprHole from '$lib/PprHole.svelte' with { fill: 'load' };

	const shell_rendered_at = new Date().getTime();
</script>

<nav><a href="/">Home</a></nav>
<hr />
<h1 data-static-shell>PPR proof</h1>
<p data-static-shell>
	shell rendered at <strong data-shell-time>{shell_rendered_at}</strong>
</p>

<PprHole>
	{#snippet ogygiaFallback()}
		<span data-hole-fallback>loading hole…</span>
	{/snippet}
</PprHole>
