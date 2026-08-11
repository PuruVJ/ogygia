<script lang="ts">
	// Live partials: a `query.live` yields an AWAITED partial each tick, so server-rendered HTML
	// rides the wire and the runtime swaps it in with NO fetch — LiveView over Kit's own SSE channel.
	// Interactive partials keep-alive (prop push, local state survives); static ones morph in place.
	import LivePartials from '$lib/LivePartials.svelte' with { wake: 'load' };
</script>

<h1 data-static-shell>Live partials</h1>
<p data-static-shell>
	The server pushes rendered, signed HTML over <code>query.live</code>. No client data code, no
	per-tick fetch. Interactive partials update by prop push (local state survives); static partials
	morph in place.
</p>

<LivePartials />
