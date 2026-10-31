<!--
	THE UNCOMPRESSED LAB: a script (~120 KB) and a JSON fetch (~30 KB) whose server answers leave
	compression off (`Content-Encoding: identity`). The devtools Page tab and the profiler's visit
	must name both files as uncompressed in a build; /dt-lab (every file compressed) never.
	(The dev server sends everything uncompressed: the finding is a build's only.)
-->
<svelte:head>
	<script src="/dt-raw/blob.js"></script>
	<script>
		addEventListener('load', () => fetch('/dt-raw/table.json').then((r) => r.json()));
	</script>
</svelte:head>

<h1>uncompressed lab</h1>
<p>Its script and its data come down as large as they are.</p>
