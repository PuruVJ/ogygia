<script lang="ts">
	import SingleFlight from '$lib/SingleFlight.svelte' with { wake: 'load' };
</script>

<h1 data-static-shell>Single-flight</h1>
<p data-static-shell>
	A command mutates server state and returns the re-rendered region in the same response. The mounted
	region morphs from the command's baked HTML — no follow-up region-endpoint fetch.
</p>
<SingleFlight />
