<script>
	// An ISLAND (interactive): its children are STATIC content that must cross the boundary frozen.
	let { children } = $props();
	let n = $state(0);
</script>

<div class="rs-inner" style="border:1px solid teal;padding:8px">
	<button class="rs-inner-btn" onclick={() => n++}>inner {n}</button>
	<div class="rs-slot">{@render children()}</div>
</div>
