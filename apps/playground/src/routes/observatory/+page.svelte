<script lang="ts">
	// The Observatory (browser compiler, Rung 1 v0) is itself an ogygia island — it runs
	// svelte/compiler + MagicString in the browser to parse marks and rewrite the host. The
	// playground is csr=false, so the interactive editor must be a `wake: 'load'` island.
	import Observatory from '$lib/Observatory.svelte' with { wake: 'load' };
</script>

<nav><a href="/">Home</a></nav>
<hr />
<h1>Observatory</h1>
<p>The ogygia compiler, running in your browser. Edit the component; watch the island map + host rewrite.</p>

<Observatory />
