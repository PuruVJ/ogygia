<script lang="ts">
	// Search box island — wakes on interaction. Its props: the suggestion list the server precomputed.
	let { suggestions }: { suggestions: string[] } = $props();
	let q = $state('');
	const hits = $derived(q ? suggestions.filter((s) => s.toLowerCase().includes(q.toLowerCase())).slice(0, 8) : []);
</script>

<form data-site-search onsubmit={(e) => e.preventDefault()}>
	<input placeholder="Search products, documents, FAQs" bind:value={q} />
	{#if hits.length}<ul>{#each hits as h (h)}<li>{h}</li>{/each}</ul>{/if}
</form>
