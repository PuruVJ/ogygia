<script lang="ts">
	// An island whose body places a server island — the nested rule renders that hole INLINE.
	import Region from '../../src/Region.svelte';
	import KeepHole from './KeepHole.svelte';
</script>

<div data-host>
	<Region __mode="server" __entry="hole-keep" __component={KeepHole} __props={{}} __defer="load">
		{#snippet ogygiaFallback()}<p data-fallback>anonymous</p>{/snippet}
	</Region>
</div>
