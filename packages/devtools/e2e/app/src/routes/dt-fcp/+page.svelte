<script lang="ts">
	// THE FIRST-PAINT LAB (devtools answer key): a stylesheet in the head answered in 2.4 s blocks the
	// first paint; the finding must name it as the costliest part, with the non-blocking fix.
	import Healthy from '$lib/dtlab/Healthy.svelte' with { wake: 'load' };
</script>

<svelte:head>
	<link rel="stylesheet" href="/dt-fcp/slow.css" />
</svelte:head>

<h1 class="dt-fcp">first paint lab</h1>
<Healthy />
