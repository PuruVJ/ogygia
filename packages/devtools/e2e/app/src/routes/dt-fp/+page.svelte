<script lang="ts">
	// THE FINGERPRINT LAB for the devtools answer key: Stamped's props carry the server's clock (a
	// value made fresh on every render), so its fingerprint moves on every load; Steady's never do.
	import Stamped from '$lib/dtfp/Stamped.svelte' with { wake: 'load' };
	import Steady from '$lib/dtfp/Steady.svelte' with { wake: 'load' };
	const stamp = Date.now();
</script>

<h1>fingerprint lab</h1>
<Stamped label="stamped" {stamp} />
<Steady label="steady" />
