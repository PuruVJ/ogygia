<script lang="ts">
	/** The `<base>/run` page: Shell + the reactive RunView island that drives the progress bar and the
	 *  profile request. Served through document() like every other profiler view. */
	import Shell from './Shell.svelte';
	import RunView from './RunView.svelte' with { wake: 'load' };
	let {
		base,
		path,
		runs,
		format
	}: { base: string; path: string; runs: number; format: string } = $props();
</script>

<Shell>
	<h1>Profiling <code>{path}</code></h1>
	<p class="hint">
		Rendering the page through your real server{format === 'ogp' ? ', then downloading the .ogp' : ''}.
		This runs the page {runs}× for a steady median — hold on.
	</p>
	<RunView {base} {path} {runs} {format} />
</Shell>
