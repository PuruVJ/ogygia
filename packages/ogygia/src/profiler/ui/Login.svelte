<script lang="ts">
	/** The locked-profiler gate. Static shell + the reactive LoginForm island. Ports render_login. */
	import Shell from './Shell.svelte';
	import LoginForm from './LoginForm.svelte' with { wake: 'load' };
	let { base, next }: { base: string; next: string } = $props();
</script>

<Shell>
	<h1>ogygia profiler <small>locked</small></h1>
	<LoginForm {base} {next} />
</Shell>
