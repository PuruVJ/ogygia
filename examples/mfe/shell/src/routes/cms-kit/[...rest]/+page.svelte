<script lang="ts">
	// The Kit-owned render of a mounted document — Kit composes pages, so the page component is
	// the app's (six lines): title+css+head via <svelte:head>, body verbatim. Islands inside
	// carry absolute entries; ogygia's runtime wakes them like any mounted fragment.
	let { data } = $props();
</script>

<svelte:head>
	{#if data.doc.title}<title>{data.doc.title}</title>{/if}
	<!-- eslint-disable-next-line svelte/no-at-html-tags — trusted federation -->
	{@html data.doc.css.join('') + (data.doc.head ?? '')}
</svelte:head>

<!-- eslint-disable-next-line svelte/no-at-html-tags — trusted federation -->
{@html data.doc.body}
