<script lang="ts">
	// Extra remote-primitive coverage (task 6): query.batch (N calls -> one request) and a
	// prerender() remote function used on a NON-prerendered page.
	import BatchProbe from '$lib/BatchProbe.svelte' with { wake: 'load' };
	import PrerenderProbe from '$lib/PrerenderProbe.svelte' with { wake: 'load' };
</script>

<h1 data-static-shell>Remote — batch &amp; prerender</h1>
<p data-static-shell>
	<code>query.batch</code> collapses three simultaneous calls into one request;
	<code>prerender</code> (dynamic) runs on the server for this non-prerendered page.
</p>

<BatchProbe />
<PrerenderProbe />
