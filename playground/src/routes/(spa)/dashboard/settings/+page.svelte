<script lang="ts">
	import Counter from '$lib/Counter.svelte' with { hydrate: 'load' };
</script>

<h1 data-static-shell>Settings</h1>
<p data-static-shell>A plain page with one counter island.</p>

<Counter start={7} label="Settings counter" />
