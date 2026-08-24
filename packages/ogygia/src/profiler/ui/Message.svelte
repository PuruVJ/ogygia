<script lang="ts">
	/** A one-off message page (errors, "not found", …). Static. Ports report.ts's render_message. */
	import Shell from './Shell.svelte';
	let { title, msg, base }: { title: string; msg: string; base: string } = $props();
</script>

<Shell>
	<h1>{title}</h1>
	<p>{msg}</p>
	<p><a href={base}>← dashboard</a></p>
</Shell>
