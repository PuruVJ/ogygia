<script lang="ts">
	// A hole whose server render throws: its endpoint answers 500, every retry too, and the page
	// keeps the fallback. The devtools must name it (the runtime is silent about it in a build).
	let { label }: { label: string } = $props();
	throw new Error(`planted: ${label} cannot render`);
</script>

<p>never shown</p>
