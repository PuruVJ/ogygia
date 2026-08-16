<script lang="ts">
	/**
	 * One whole blog POST — the blog genre's answer to `<Doc>`. A pure function of a `PageView` whose
	 * `data` carries the `PostFields` (`date`, `author?`, `tags`): a dateline, the title, the author,
	 * tags, the rendered body, and prev/next by date. No sidebar, no on-this-page rail — a post reads
	 * top to bottom. Styling rides the `.og-*` tokens; blog-specific structure is scoped below.
	 */
	import Region from '../../../Region.svelte';
	import CodeChrome from './CodeChrome.svelte' with { wake: 'load' };
	import { get_shell_context } from '../context.js';
	import type { PageView } from '../types.js';
	import type { PostFields } from '../fields.js';
	import type { Snippet } from 'svelte';

	let {
		view,
		back,
		backLabel = '← All posts',
		footer
	}: {
		view: PageView<{ title?: string; summary?: string } & Partial<PostFields>>;
		/** Href of the blog index (the "back" link above the title). Omit to hide it. */
		back?: string;
		backLabel?: string;
		/** Rendered after the body — a newsletter CTA, share row, comments island. */
		footer?: Snippet;
	} = $props();

	const shell = get_shell_context();
	const data = $derived(view.entry.data);
	const title = $derived(data.title ?? view.slug);
	const doc_title = $derived(shell?.title ? `${title} — ${shell.title}` : title);
	const iso = $derived(data.date ?? '');
	const pretty = $derived(
		iso ? new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' }) : ''
	);
	const prev = $derived(view.trail.prev);
	const next = $derived(view.trail.next);
</script>

<svelte:head>
	<title>{doc_title}</title>
	{#if data.summary}<meta name="description" content={data.summary} />{/if}
	{#if data.author}<meta name="author" content={data.author} />{/if}
	{#if iso}<meta property="article:published_time" content={iso} />{/if}
</svelte:head>

<article class="og-post">
	{#if back}<a class="og-post-back" href={back}>{backLabel}</a>{/if}

	<header class="og-post-head">
		<div class="og-post-dateline">
			{#if pretty}<time datetime={iso}>{pretty}</time>{/if}
			{#if data.author}<span class="og-post-sep">·</span><span class="og-post-author">{data.author}</span>{/if}
		</div>
		<h1 class="og-post-title">{title}</h1>
		{#if data.summary}<p class="og-post-summary">{data.summary}</p>{/if}
		{#if data.tags?.length}
			<ul class="og-post-tags">
				{#each data.tags as t (t)}<li class="og-post-tag">{t}</li>{/each}
			</ul>
		{/if}
	</header>

	{#if view.entry.body}
		<div class="og-post-body og-body"><Region of={view.entry.body} /></div>
		<CodeChrome />
	{/if}

	{#if footer}<div class="og-post-footer">{@render footer()}</div>{/if}

	{#if prev || next}
		<nav class="og-post-pager" aria-label="More posts">
			{#if prev}
				<a class="og-post-pager-link og-post-prev" href={prev.href} rel="prev">
					<span class="og-post-pager-dir">Previous</span>
					<span class="og-post-pager-title">{prev.title}</span>
				</a>
			{:else}<span></span>{/if}
			{#if next}
				<a class="og-post-pager-link og-post-next" href={next.href} rel="next">
					<span class="og-post-pager-dir">Next</span>
					<span class="og-post-pager-title">{next.title}</span>
				</a>
			{/if}
		</nav>
	{/if}
</article>

<style>
	.og-post {
		max-width: 44rem;
		margin: 0 auto;
		padding: 0 1.25rem;
	}
	.og-post-back {
		display: inline-block;
		margin-bottom: 1.5rem;
		font-size: 0.85rem;
		color: var(--og-text-dim);
		text-decoration: none;
	}
	.og-post-back:hover {
		color: var(--og-accent);
	}
	.og-post-dateline {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
		color: var(--og-text-dim);
	}
	.og-post-sep {
		opacity: 0.5;
	}
	.og-post-title {
		margin: 0.6rem 0 0;
		font-size: clamp(1.9rem, 4vw, 2.7rem);
		line-height: 1.12;
		letter-spacing: -0.02em;
		text-wrap: balance;
	}
	.og-post-summary {
		margin: 0.9rem 0 0;
		font-size: 1.15rem;
		line-height: 1.5;
		color: var(--og-text-dim);
	}
	.og-post-tags {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 1rem 0 0;
		padding: 0;
	}
	.og-post-tag {
		font-size: 0.72rem;
		letter-spacing: 0.02em;
		color: var(--og-text-dim);
		background: var(--og-surface-2, color-mix(in oklab, currentColor 7%, transparent));
		padding: 0.15rem 0.55rem;
		border-radius: 999px;
	}
	.og-post-body {
		margin-top: 2.5rem;
		font-size: 1.05rem;
		line-height: 1.75;
	}
	.og-post-footer {
		margin-top: 3rem;
		padding-top: 2rem;
		border-top: 1px solid var(--og-border);
	}
	.og-post-pager {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
		margin-top: 3.5rem;
		padding-top: 2rem;
		border-top: 1px solid var(--og-border);
	}
	.og-post-pager-link {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.9rem 1.1rem;
		border: 1px solid var(--og-border);
		border-radius: 12px;
		text-decoration: none;
		color: var(--og-text);
		transition: border-color 0.15s ease, background 0.15s ease;
	}
	.og-post-pager-link:hover {
		border-color: var(--og-accent);
		background: color-mix(in oklab, var(--og-accent) 5%, transparent);
	}
	.og-post-next {
		text-align: right;
	}
	.og-post-pager-dir {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--og-text-dim);
	}
	.og-post-pager-title {
		font-weight: 600;
		font-size: 0.95rem;
	}
	@media (max-width: 640px) {
		.og-post-pager {
			grid-template-columns: 1fr;
		}
		.og-post-next {
			text-align: left;
		}
	}
</style>
