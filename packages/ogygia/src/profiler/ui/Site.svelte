<script lang="ts">
	/** `<base>/site`: the whole-site pictures. Shell + the SiteView island (the request cloud with a
	 *  brushable selection, and the layer cake per route), fed by this instance's rows or a sink URL
	 *  the browser reads. */
	import Shell from './Shell.svelte';
	import SiteView from './SiteView.svelte' with { wake: 'load' };
	import type { ProfilerRoutes } from '../profiler-router.js';
	let { data }: ProfilerRoutes['/site'] = $props();
	const { base, rows, from, sink, ephemeral } = $derived(data);
</script>

<svelte:head><title>the whole site — profiler</title></svelte:head>

<Shell {base}>
	<h1>The whole site <small>every request, and where the time goes per route</small></h1>
	<p class="hint"><a href={base}>← dashboard</a> · {rows.length} rows from this instance{ephemeral ? ' (ephemeral: seconds of memory — use a sink)' : ''}</p>
	<SiteView {base} {rows} {from} {sink} {ephemeral} />
</Shell>
