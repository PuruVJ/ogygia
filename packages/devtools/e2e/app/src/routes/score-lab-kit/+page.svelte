<script lang="ts">
	// SCORE LAB, fully hydrated twin (csr=true, no islands): the same article and editor, shipped the
	// usual SvelteKit way — the whole page and the editor's code run at start. The profiler's page
	// score must rank it well below /score-lab, and count its JS (no islands is not "0 JS").
	import Article from '$lib/scorelab/Article.svelte';
	import Editor from '$lib/scorelab/Editor.svelte';
</script>

<Article />
<div style="height: 1200px" aria-hidden="true"></div>
<Editor doc="const answer = 42;" />
