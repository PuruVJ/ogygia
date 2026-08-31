<script lang="ts">
	/** The router's error boundary (Kit's +error.svelte) for the profiler — renders any c.error(). Static. */
	import Shell from './Shell.svelte';
	let {
		status,
		error,
		data
	}: { status: number; error: { message: string }; data: { base: string } } = $props();
</script>

<Shell>
	<h1>Error {status}</h1>
	<p>{error.message}</p>
	<p><a href={data.base}>← dashboard</a></p>
</Shell>
