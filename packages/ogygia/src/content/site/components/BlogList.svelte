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
		<a class="og-blog-card" href={p.href}>
			<time class="og-blog-card-date" datetime={p.date}>{pretty(p.date)}</time>
			<div class="og-blog-card-main">
				<h3 class="og-blog-card-title">{p.title}</h3>
				{#if p.summary}<p class="og-blog-card-summary">{p.summary}</p>{/if}
				<div class="og-blog-card-meta">
					{#if p.author}<span class="og-blog-card-author">{p.author}</span>{/if}
					{#if p.tags?.length}
						<span class="og-blog-card-tags">{#each p.tags as t (t)}<span class="og-blog-card-tag">{t}</span>{/each}</span>
					{/if}
				</div>
			</div>
		</a>
	{/if}
{/snippet}

<section class="og-blog">
	<header class="og-blog-head">
		<h1 class="og-blog-title">{title}</h1>
		{#if intro}<p class="og-blog-intro">{intro}</p>{/if}
	</header>

	{#if group}
		{#each byYear as [year, items] (year)}
			<section class="og-blog-year">
				<h2 class="og-blog-year-label">{year}</h2>
				<ul class="og-blog-list">
					{#each items as p (p.href)}<li>{@render card(p)}</li>{/each}
				</ul>
			</section>
		{/each}
	{:else}
		<ul class="og-blog-list">
			{#each sorted as p (p.href)}<li>{@render card(p)}</li>{/each}
		</ul>
	{/if}
</section>

<style>
	.og-blog {
		max-width: 46rem;
		margin: 0 auto;
		padding: 0 1.25rem;
	}
	.og-blog-title {
		font-size: clamp(2rem, 5vw, 3rem);
		letter-spacing: -0.02em;
		margin: 0;
	}
	.og-blog-intro {
		margin: 0.6rem 0 0;
		font-size: 1.15rem;
		color: var(--og-text-dim);
	}
	.og-blog-year {
		margin-top: 2.5rem;
	}
	.og-blog-year-label {
		font-size: 0.85rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		color: var(--og-text-dim);
		margin: 0 0 0.5rem;
		padding-bottom: 0.4rem;
		border-bottom: 1px solid var(--og-border);
	}
	.og-blog-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.og-blog-card {
		display: grid;
		grid-template-columns: 5.5rem 1fr;
		gap: 1rem;
		padding: 1.1rem 0.75rem;
		border-radius: 12px;
		text-decoration: none;
		color: inherit;
		transition: background 0.15s ease;
	}
	.og-blog-card:hover {
		background: color-mix(in oklab, var(--og-accent) 5%, transparent);
	}
	.og-blog-card:hover .og-blog-card-title {
		color: var(--og-accent);
	}
	.og-blog-card-date {
		font-size: 0.82rem;
		color: var(--og-text-dim);
		padding-top: 0.2rem;
		font-variant-numeric: tabular-nums;
	}
	.og-blog-card-title {
		margin: 0;
		font-size: 1.2rem;
		line-height: 1.3;
		transition: color 0.15s ease;
	}
	.og-blog-card-summary {
		margin: 0.35rem 0 0;
		font-size: 0.95rem;
		line-height: 1.55;
		color: var(--og-text-dim);
	}
	.og-blog-card-meta {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-top: 0.5rem;
		font-size: 0.78rem;
		color: var(--og-text-dim);
	}
	.og-blog-card-tags {
		display: inline-flex;
		gap: 0.3rem;
		flex-wrap: wrap;
	}
	.og-blog-card-tag {
		background: var(--og-surface-2, color-mix(in oklab, currentColor 7%, transparent));
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
	}
	@media (max-width: 560px) {
		.og-blog-card {
			grid-template-columns: 1fr;
			gap: 0.35rem;
		}
	}
</style>
