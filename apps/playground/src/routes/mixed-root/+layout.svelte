<script lang="ts">
	// csr=true host: the transform injects the `true` marker here; context flows down.
	let { children } = $props();
</script>
<div data-mixed-root>{@render children()}</div>
