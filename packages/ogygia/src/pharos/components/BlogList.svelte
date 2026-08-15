<script lang="ts">
	/**
	 * The blog INDEX — the dated post list, newest first, optionally grouped by year (svelte.dev's
	 * shape). Pure data in: an array of post refs (`{ href, title, date, summary?, author?, tags? }`),
	 * typically `blog.list({ map })` over the wire so the corpus stays server-side. Renders each as a
	 * card. No brains here; the ordering is done for you but you can pre-sort and pass `group={false}`.
	 */
	import type { Snippet } from 'svelte';
	import type { BlogPostRef } from '../fields.js';

	let {
		posts,
		title = 'Blog',
		intro,
		group = true,
		item
	}: {
		posts: BlogPostRef[];
		title?: string;
		/** Lede under the page title. */
		intro?: string;
		/** Group by year with a year heading (default). `false` → one flat list in the given order. */
		group?: boolean;
		/** Override a single card's rendering. */
		item?: Snippet<[BlogPostRef]>;
	} = $props();

	// Newest first; stable for equal dates.
	const sorted = $derived([...posts].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)));
	const byYear = $derived.by(() => {
		const groups: Array<[string, BlogPostRef[]]> = [];
		for (const p of sorted) {
			const y = (p.date ?? '').slice(0, 4) || '—';
			const last = groups[groups.length - 1];
			if (last && last[0] === y) last[1].push(p);
			else groups.push([y, [p]]);
		}
		return groups;
	});
	const pretty = (iso: string) =>
		iso ? new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '';
</script>

{#snippet card(p: BlogPostRef)}
	{#if item}{@render item(p)}{:else}
		<a class="ph-blog-card" href={p.href}>
			<time class="ph-blog-card-date" datetime={p.date}>{pretty(p.date)}</time>
			<div class="ph-blog-card-main">
				<h3 class="ph-blog-card-title">{p.title}</h3>
				{#if p.summary}<p class="ph-blog-card-summary">{p.summary}</p>{/if}
				<div class="ph-blog-card-meta">
					{#if p.author}<span class="ph-blog-card-author">{p.author}</span>{/if}
					{#if p.tags?.length}
						<span class="ph-blog-card-tags">{#each p.tags as t (t)}<span class="ph-blog-card-tag">{t}</span>{/each}</span>
					{/if}
				</div>
			</div>
		</a>
	{/if}
{/snippet}

<section class="ph-blog">
	<header class="ph-blog-head">
		<h1 class="ph-blog-title">{title}</h1>
		{#if intro}<p class="ph-blog-intro">{intro}</p>{/if}
	</header>

	{#if group}
		{#each byYear as [year, items] (year)}
			<section class="ph-blog-year">
				<h2 class="ph-blog-year-label">{year}</h2>
				<ul class="ph-blog-list">
					{#each items as p (p.href)}<li>{@render card(p)}</li>{/each}
				</ul>
			</section>
		{/each}
	{:else}
		<ul class="ph-blog-list">
			{#each sorted as p (p.href)}<li>{@render card(p)}</li>{/each}
		</ul>
	{/if}
</section>

<style>
	.ph-blog {
		max-width: 46rem;
		margin: 0 auto;
		padding: 0 1.25rem;
	}
	.ph-blog-title {
		font-size: clamp(2rem, 5vw, 3rem);
		letter-spacing: -0.02em;
		margin: 0;
	}
	.ph-blog-intro {
		margin: 0.6rem 0 0;
		font-size: 1.15rem;
		color: var(--ph-text-dim);
	}
	.ph-blog-year {
		margin-top: 2.5rem;
	}
	.ph-blog-year-label {
		font-size: 0.85rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		color: var(--ph-text-dim);
		margin: 0 0 0.5rem;
		padding-bottom: 0.4rem;
		border-bottom: 1px solid var(--ph-border);
	}
	.ph-blog-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.ph-blog-card {
		display: grid;
		grid-template-columns: 5.5rem 1fr;
		gap: 1rem;
		padding: 1.1rem 0.75rem;
		border-radius: 12px;
		text-decoration: none;
		color: inherit;
		transition: background 0.15s ease;
	}
	.ph-blog-card:hover {
		background: color-mix(in oklab, var(--ph-accent) 5%, transparent);
	}
	.ph-blog-card:hover .ph-blog-card-title {
		color: var(--ph-accent);
	}
	.ph-blog-card-date {
		font-size: 0.82rem;
		color: var(--ph-text-dim);
		padding-top: 0.2rem;
		font-variant-numeric: tabular-nums;
	}
	.ph-blog-card-title {
		margin: 0;
		font-size: 1.2rem;
		line-height: 1.3;
		transition: color 0.15s ease;
	}
	.ph-blog-card-summary {
		margin: 0.35rem 0 0;
		font-size: 0.95rem;
		line-height: 1.55;
		color: var(--ph-text-dim);
	}
	.ph-blog-card-meta {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-top: 0.5rem;
		font-size: 0.78rem;
		color: var(--ph-text-dim);
	}
	.ph-blog-card-tags {
		display: inline-flex;
		gap: 0.3rem;
		flex-wrap: wrap;
	}
	.ph-blog-card-tag {
		background: var(--ph-surface-2, color-mix(in oklab, currentColor 7%, transparent));
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
	}
	@media (max-width: 560px) {
		.ph-blog-card {
			grid-template-columns: 1fr;
			gap: 0.35rem;
		}
	}
</style>
