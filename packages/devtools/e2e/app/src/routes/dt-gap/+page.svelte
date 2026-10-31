<script lang="ts">
	// THE TTFB-GAP LAB (profiler answer key): the page renders at once; the app's hooks hold a visitor's
	// request 900 ms in front of ogygia.handle() (`?front`) or behind it (`?inside`) — see
	// hooks.server.ts. The report's ttfb-gap must say which side of the handler the time was on.
	import Healthy from '$lib/dtlab/Healthy.svelte' with { wake: 'load' };
</script>

<h1>ttfb gap lab</h1>
<Healthy />
