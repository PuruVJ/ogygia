<script lang="ts">
	/**
	 * Releases — a timeline of every cut, rendered from the repo-root CHANGELOG.md at build
	 * (see releases.server.ts). Pure static HTML: the version rail sits beside the notes, code
	 * blocks carry the site's Shiki theme, prose reuses the `.prose` tokens.
	 */
	import PageHead from '$lib/PageHead.svelte';
	import '$lib/styles/code-block.css';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
	// Format from the ISO parts directly — no `new Date()`, so no timezone can shift the day.
	function pretty(iso: string): string {
		const [y, m, d] = iso.split('-').map(Number);
		return y && m && d ? `${MONTHS[m - 1]} ${d}, ${y}` : '';
	}
</script>

<PageHead
	title="Releases"
	category="Changelog"
	description="Every cut of ogygia, newest first — sourced from the changelog."
/>

<main class="shell releases">
	<header class="releases-head">
		<span class="eyebrow">Changelog</span>
		<h1 class="releases-title">Releases</h1>
		<p class="releases-lede">
			Every cut of ogygia, newest first. This page is rendered straight from
			<a href="https://github.com/PuruVJ/ogygia/blob/main/CHANGELOG.md">CHANGELOG.md</a> — one source
			of truth for what shipped.
		</p>
	</header>

	<ol class="rel-list">
		{#each data.releases as r (r.version)}
			<li class="rel">
				<div class="rel-rail">
					<a class="rel-version" id="v{r.version}" href="#v{r.version}">{r.version}</a>
					{#if r.date}<time class="rel-date" datetime={r.date}>{pretty(r.date)}</time>{/if}
				</div>
				<div class="rel-notes prose">
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html r.html}
				</div>
			</li>
		{/each}
	</ol>
</main>

<style>
	.releases {
		padding-block: 3.5rem 5rem;
	}
	.releases-head {
		max-width: none;
		margin-bottom: 3rem;
	}
	.releases-title {
		margin: 0;
		font: 600 clamp(2rem, 4vw, 2.75rem) / 1.05 var(--font-body);
		letter-spacing: -0.02em;
		color: var(--text);
	}
	.releases-lede {
		margin: 0.75rem 0 0;
		max-width: 42rem;
		color: var(--text-dim);
		font-size: 1.0625rem;
		line-height: 1.6;
	}
	.releases-lede a {
		color: var(--accent);
		text-decoration: none;
	}
	.releases-lede a:hover {
		text-decoration: underline;
	}

	.rel-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.rel {
		display: grid;
		grid-template-columns: 12rem 1fr;
		gap: 2.5rem;
		padding-block: 2.5rem;
		border-top: 1px solid var(--line);
	}
	.rel:first-child {
		border-top: none;
		padding-top: 0;
	}

	.rel-rail {
		position: sticky;
		top: 1.5rem;
		align-self: start;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.rel-version {
		font: 600 1.35rem/1 var(--font-mono);
		letter-spacing: -0.01em;
		color: var(--text);
		text-decoration: none;
		width: fit-content;
	}
	.rel-version:hover {
		color: var(--accent);
	}
	.rel-date {
		font: 400 0.8125rem/1 var(--font-mono);
		color: var(--text-faint);
	}

	/* The changelog HTML is injected, so its elements are styled globally under the notes column. */
	.rel-notes :global(h3) {
		margin: 1.75rem 0 0.75rem;
		font: 600 0.75rem/1 var(--font-mono);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.rel-notes :global(h3:first-child) {
		margin-top: 0;
	}
	.rel-notes :global(h4) {
		margin: 1.25rem 0 0.5rem;
		font: 600 1rem/1.35 var(--font-body);
		color: var(--text);
	}
	.rel-notes :global(a) {
		color: var(--accent);
		text-decoration: none;
	}
	.rel-notes :global(a:hover) {
		text-decoration: underline;
	}
	.rel-notes :global(code) {
		font: 0.85em/1 var(--font-mono);
		color: var(--accent);
		background: var(--bg-sunken);
		padding: 0.12em 0.36em;
		border-radius: var(--r-sm, 5px);
	}
	.rel-notes :global(pre) {
		margin: 0 0 1rem;
		padding: 1rem 1.15rem;
		overflow-x: auto;
		border: 1px solid var(--line);
		border-radius: var(--r-md, 10px);
		background: var(--bg-sunken);
		font-size: 0.85rem;
		line-height: 1.6;
	}
	.rel-notes :global(pre code) {
		color: inherit;
		background: none;
		padding: 0;
		border-radius: 0;
		font-size: inherit;
	}
	.rel-notes :global(blockquote) {
		margin: 0 0 1rem;
		padding-left: 1rem;
		border-left: 2px solid var(--accent-line, var(--line-strong));
		color: var(--text-dim);
	}

	@media (max-width: 720px) {
		.rel {
			grid-template-columns: 1fr;
			gap: 1rem;
		}
		.rel-rail {
			position: static;
			flex-direction: row;
			align-items: baseline;
			gap: 0.75rem;
		}
	}
</style>
