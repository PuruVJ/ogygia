<script lang="ts">
	// Deferred client islands: fetch signed HTML on the defer schedule, then hydrate JS on
	// the hydrate schedule (matching schedules coalesce to immediate hydrate after swap).
	import Match from '$lib/Counter.svelte' with { defer: 'load', hydrate: 'load' };
	import IdleMatch from '$lib/Counter.svelte' with { defer: 'idle', hydrate: 'idle' };
	import Mismatch from '$lib/Counter.svelte' with { defer: 'load', hydrate: 'visible' };
</script>

<h1 data-static-shell>Deferred client islands</h1>
<p data-static-shell>
	<code>defer</code> + <code>hydrate</code>: phase 1 swaps HTML, phase 2 makes the counter
	interactive. Matching schedules coalesce (no second idle/IO); mismatched
	<code>hydrate: 'visible'</code> waits until scrolled into view.
</p>

<section data-dh="match">
	<h2 data-static-shell>defer:load + hydrate:load (coalesce)</h2>
	<Match label="match" start={0}>
		{#snippet ogygiaFallback()}
			<p class="fb" data-fallback-match>loading match…</p>
		{/snippet}
	</Match>
</section>

<section data-dh="idle-match">
	<h2 data-static-shell>defer:idle + hydrate:idle (coalesce after idle fetch)</h2>
	<IdleMatch label="idle-match" start={0}>
		{#snippet ogygiaFallback()}
			<p class="fb" data-fallback-idle-match>loading idle-match…</p>
		{/snippet}
	</IdleMatch>
</section>

<!-- spacer so mismatch hydrate:visible does not fire until scrolled -->
<div style="height: 2400px" data-static-shell aria-hidden="true"></div>

<section data-dh="mismatch">
	<h2 data-static-shell>defer:load + hydrate:visible (second schedule)</h2>
	<Mismatch label="mismatch" start={0}>
		{#snippet ogygiaFallback()}
			<p class="fb" data-fallback-mismatch>loading mismatch…</p>
		{/snippet}
	</Mismatch>
</section>

<style>
	.fb {
		padding: 8px 12px;
		border: 2px dashed #999;
		border-radius: 8px;
		color: #666;
	}
</style>
