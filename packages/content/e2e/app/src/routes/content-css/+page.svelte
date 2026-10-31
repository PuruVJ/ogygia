<script lang="ts">
	import { Region } from 'ogygia';
	let { data } = $props();
</script>

<h1>content css</h1>
{#if data.body}<Region of={data.body} />{/if}
