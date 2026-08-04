<script lang="ts">
	// Nested islands: Outer is an island; its source imports Inner `with { island }`. The inner
	// island degrades to a normal component and hydrates once, with Outer. Only ONE <sk-island>
	// element is emitted (the outer); the inner renders inline.
	import Outer from '$lib/Outer.svelte' with { hydrate: 'load' };
</script>

<h1 data-static-shell>Nested islands</h1>
<p data-static-shell>
	Outer is a <code>load</code> island. Its own source imports Inner as a
	<code>visible</code> island. Inner degrades to a normal component and hydrates with Outer —
	one hydration, both interactive.
</p>

<Outer title="A" />
