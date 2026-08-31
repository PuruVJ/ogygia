<script lang="ts">
	/** The locked-profiler gate. Static shell + the reactive LoginForm island. Ports render_login. */
	import Shell from './Shell.svelte';
	import LoginForm from './LoginForm.svelte' with { wake: 'load' };
	import type { ProfilerRoutes } from '../profiler-router.js';
	let { data }: ProfilerRoutes['/login'] = $props();
	const { base, next } = $derived(data);
</script>

<Shell>
	<h1>ogygia profiler <small>locked</small></h1>
	<LoginForm {base} {next} />
</Shell>
