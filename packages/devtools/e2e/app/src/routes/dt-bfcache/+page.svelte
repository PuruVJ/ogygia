<script lang="ts">
	// THE BACK/FORWARD CACHE LAB for the devtools answer key. Saver listens to 'unload' (the plant: the
	// page leaves the cache); Tidy to 'pagehide' (the decoy). Only Saver is named.
	import Saver from '$lib/dtbf/Saver.svelte' with { wake: 'load' };
	import Tidy from '$lib/dtbf/Tidy.svelte' with { wake: 'load' };
</script>

<h1>back/forward cache lab</h1>
<Saver />
<Tidy />
