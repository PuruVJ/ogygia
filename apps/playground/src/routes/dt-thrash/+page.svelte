<script lang="ts">
	// THE FORCED-LAYOUT LAB for the devtools answer key. Thrash writes a width and reads it back 400
	// times as it wakes (the plant); Batched does the same work with every write before every read
	// (the decoy). Only Thrash is named.
	import Thrash from '$lib/dtthrash/Thrash.svelte' with { wake: 'load' };
	import Batched from '$lib/dtthrash/Batched.svelte' with { wake: 'load' };
</script>

<h1>forced layout lab</h1>
<Thrash />
<Batched />
