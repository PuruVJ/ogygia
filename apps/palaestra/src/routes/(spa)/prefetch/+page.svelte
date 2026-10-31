<script lang="ts">
	// Router prefetch parity demo (SvelteKit `data-sveltekit-preload-*`). The SPA router warms its
	// page-HTML cache on the trigger declared by these attributes (nearest ancestor wins). A prefetched
	// page swaps in on click without a second network request.
</script>

<h1 data-static-shell>Router prefetch parity</h1>
<p data-static-shell>Each link opts into a different preload trigger; hover/click to see the cache warm.</p>

<!-- hover: a container enables hover-preload for its descendants (ancestor inheritance) -->
<div data-sveltekit-preload-data="hover">
	<a href="/about" data-prefetch-hover>Hover to preload /about</a>
</div>

<!-- tap: preload on press (mousedown/touchstart), not on hover -->
<p><a href="/forms" data-sveltekit-preload-data="tap" data-prefetch-tap>Tap to preload /forms</a></p>

<!-- off override: inside a hover container, but this link disables preload (nearest wins) -->
<div data-sveltekit-preload-data="hover">
	<a href="/data" data-sveltekit-preload-data="off" data-prefetch-off>No preload for /data (off overrides hover)</a>
</div>

<!-- code: eager -> warmed immediately on load; maps to the same HTML prefetch in this router -->
<p><a href="/server" data-sveltekit-preload-code="eager" data-prefetch-eager>/server (eager code preload)</a></p>

<!-- code: viewport -> warmed when scrolled into view -->
<div style="height: 2200px" data-static-shell aria-hidden="true"></div>
<p><a href="/nested" data-sveltekit-preload-code="viewport" data-prefetch-viewport>/nested (viewport code preload)</a></p>
