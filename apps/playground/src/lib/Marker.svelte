<script module lang="ts">
	// One stamp per DOCUMENT LOAD: the module evaluates once per document, so an SPA navigation
	// (same window, same module graph) keeps it and a real reload draws a new one.
	const stamp = Math.random();
</script>

<div class="island" data-marker-island>
	document stamp: <span data-marker-value>{stamp}</span>
</div>
