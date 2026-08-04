<script lang="ts">
	// Mixed mode: an island on a csr=true page. Kit hydrates the whole tree, so the
	// island degrades gracefully to a normal component (single hydration; our runtime
	// detects Kit and skips its own hydration).
	import Counter from '$lib/Counter.svelte' with { hydrate: 'load' };
	import KitStatus from '$lib/KitStatus.svelte';
</script>

<nav><a href="/">Home</a> <a href="/kit">Kit page</a></nav>
<hr />
<h1 data-static-shell>Kit page (csr = true) — coexistence demo</h1>
<p data-static-shell>
	This page opts into full Kit hydration. The island below still works, but Kit hydrates it
	(exactly once) as a normal component.
</p>

<Counter start={42} label="Island on a csr=true page" />

<KitStatus />
