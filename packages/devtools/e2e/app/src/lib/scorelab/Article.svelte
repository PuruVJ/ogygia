<script lang="ts">
	// The score lab's content: the same article on both twin pages.
	const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: the same words on both pages, so only how each page ships its code differs.`);
</script>

<article>
	<h1>Score lab</h1>
	{#each paragraphs as p (p)}<p>{p}</p>{/each}
</article>
