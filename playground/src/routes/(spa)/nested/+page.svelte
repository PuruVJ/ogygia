<script lang="ts">
	// Nested regions: Outer is a waking region; its source imports Inner `with { wake }`. The
	// inner region degrades to a normal component and hydrates once, with Outer. Only ONE
	// <ogygia-region> element is emitted (the outer); the inner renders inline.
	import Outer from '$lib/Outer.svelte' with { wake: 'load' };
</script>

<h1 data-static-shell>Nested islands</h1>
<p data-static-shell>
	Outer is a <code>load</code> island. Its own source imports Inner as a
	<code>visible</code> island. Inner degrades to a normal component and hydrates with Outer —
	one hydration, both interactive.
</p>

<Outer title="A" />
