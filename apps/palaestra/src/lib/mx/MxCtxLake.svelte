<script lang="ts">
	// Static furniture (placed as a lake) holding a context reader and a waking island that reads it too.
	import MxCtxRead from './MxCtxRead.svelte';
	import MxCtxIsland from './MxCtxIsland.svelte' with { wake: 'visible' };
</script>

<div data-snip-lake>lake <MxCtxRead label="lake" /> <MxCtxIsland /></div>
