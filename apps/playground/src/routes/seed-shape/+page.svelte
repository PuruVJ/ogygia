<script lang="ts">
	import SeedShapeReader from '$lib/SeedShapeReader.svelte' with { wake: 'load' };
	import { page } from '$app/state';
</script>

<h1 data-page>seed shaping</h1>
<p data-server-big-len>server sees big: {(page.data.big as string).length}</p>
<SeedShapeReader />
