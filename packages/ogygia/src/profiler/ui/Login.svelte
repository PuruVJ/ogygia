<script lang="ts">
	/** The locked-profiler gate. Static shell + the reactive LoginForm island. Ports render_login. */
	import Shell from './Shell.svelte';
	import LoginForm from './LoginForm.svelte' with { wake: 'load' };
	import type { ProfilerRoutes } from '../profiler-router.js';
	let { data }: ProfilerRoutes['/login'] = $props();
	const { base, next, session_problem } = $derived(data);
</script>

<Shell {base} bare>
	<h1>ogygia profiler <small>locked</small></h1>
	<!-- A login that succeeded but whose session never reached the server: say why, don't loop. -->
	{#if session_problem}<p class="verdict" data-session-problem>{session_problem}</p>{/if}
	<LoginForm {base} {next} />
</Shell>
