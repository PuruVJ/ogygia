<script lang="ts">
	import { page } from '$app/state';
	import { Doc } from 'ogygia/content';
	import type { DocView } from 'ogygia/content';
	import type { DocData } from '$lib/collections.server';
	import { doc } from '$lib/docs.remote';
	import PageHead from '$lib/PageHead.svelte';
	// Island (re-hydrates per SPA nav, like CodeChrome) that localizes the changelog's release dates.
	import LocaleDates from '$lib/LocaleDates.svelte' with { wake: 'load' };
	// The `.og-*` doc body painted in the SITE's look (the customization-ladder skin — no ogygia
	// theme.css anywhere); code-block.css styles the Shiki fences.
	import '$lib/styles/doc-skin.css';
	import '$lib/styles/code-block.css';

	// Dogfood the `.server.ts` rule: the component imports the `doc` REMOTE, never the collection.
	// `doc` bakes the entry's body into a region ticket (`<Doc>` renders it via `<Region>`); the
	// `.svx` demos inside wake from the baked HTML exactly as an in-pass render would. csr=false.
	const view = (await doc(page.params.slug ?? ''))! as DocView<DocData>;
	const data = view.entry.data;
	const isChangelog = view.slug === 'start/releases';
</script>

<PageHead title={data.title} category={view.section} description={data.summary} />

<div class:changelog={isChangelog}>
	<Doc {view} crumbs={false} keepReading={view.trail?.related} />
	{#if isChangelog}<LocaleDates />{/if}
</div>

<style>
	/* Releases page only. The `remark-changelog` plugin turns each `## [x] — date` into an `<h2>x</h2>`
	   plus a `.release-date` line; here we dress them and flatten the section lists so entries read as
	   flush release notes rather than deeply-indented bullets. */
	.changelog :global(.og-body h2) {
		margin-top: 4rem;
		margin-bottom: 0;
		padding-top: 2.5rem;
		border-top: 1px solid var(--line);
		font-size: clamp(1.9rem, 3vw, 2.4rem);
	}
	.changelog :global(.og-body h2:first-of-type) {
		margin-top: 1.5rem;
		padding-top: 0;
		border-top: none;
	}
	.changelog :global(.release-date) {
		display: inline-block;
		margin: 0.6rem 0 2rem;
		padding: 0.2rem 0.55rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		font: 500 0.75rem/1 var(--font-mono);
		letter-spacing: 0.03em;
		color: var(--text-dim);
	}
	/* The release headline (first paragraph after the date) reads as a lede. */
	.changelog :global(.release-date + p) {
		font-size: 1.05rem;
		line-height: 1.6;
		color: var(--text);
	}
	/* Top-level entries: flush, no bullet, generous spacing (they're substantial notes). */
	.changelog :global(.og-body ul) {
		list-style: none;
		padding-left: 0;
	}
	.changelog :global(.og-body li) {
		margin: 0.9rem 0;
	}
	/* Nested sub-points keep a marker + indent so they stay legible. */
	.changelog :global(.og-body li ul) {
		list-style: disc;
		padding-left: 1.2rem;
		margin: 0.5rem 0;
	}
	.changelog :global(.og-body li li) {
		margin: 0.3rem 0;
	}
</style>
