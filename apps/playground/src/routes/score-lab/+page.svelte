<script lang="ts">
	// SCORE LAB, islands twin (csr=false): the article is plain HTML; the editor is an island that
	// loads its code when it scrolls into view. Its fully hydrated twin is /score-lab-kit — the
	// profiler's page score must rank this one well above it (internal/bench/profiler-answer-key.mjs).
	import Article from '$lib/scorelab/Article.svelte';
	import Editor from '$lib/scorelab/Editor.svelte' with { wake: 'visible' };
</script>

<Article />
<div style="height: 1200px" aria-hidden="true"></div>
<Editor doc="const answer = 42;" />
