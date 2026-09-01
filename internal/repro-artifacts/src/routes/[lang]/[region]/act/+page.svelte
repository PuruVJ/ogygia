<script lang="ts">
	let { data } = $props();
</script>

<h1 data-artifact-page>act</h1>
<p>render <span data-render>{data.render}</span></p>
<p>tally <span data-tally>{data.tally}</span></p>
<form method="POST">
	<button type="submit">bump</button>
</form>
