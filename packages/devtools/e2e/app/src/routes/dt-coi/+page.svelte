<script lang="ts">
	// (one island: a visit is sent once the beacon hears its wake)
	import Healthy from '$lib/dtlab/Healthy.svelte' with { wake: 'load' };
</script>

<h1>cross-origin-isolated lab</h1>
<p>This page is sent with COOP and COEP: Safari hides its first byte.</p>
<Healthy />
