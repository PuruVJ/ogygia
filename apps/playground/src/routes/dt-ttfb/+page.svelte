<script lang="ts">
	// THE FIRST-BYTE LAB (devtools answer key): /dt-ttfb waits on its load (the server's answer the
	// cost, its Server-Timing naming the database); /dt-ttfb-go redirects here after 900 ms (the
	// redirect the cost). Each must be named with its step.
	import Healthy from '$lib/dtlab/Healthy.svelte' with { wake: 'load' };
</script>

<h1>first byte lab</h1>
<Healthy />
