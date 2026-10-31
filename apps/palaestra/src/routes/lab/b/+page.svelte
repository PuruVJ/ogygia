<script lang="ts">
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
</script>

<h1 data-lab-page>Page B</h1>
<p>
	Same idea as Page A but different props (<code>start=2</code>) — so this counter re-mounts on nav
	while the layout island stays alive. Increment the layout island, bounce A ⇄ B, watch what persists.
</p>
<Counter start={2} label="page-B-counter" />
