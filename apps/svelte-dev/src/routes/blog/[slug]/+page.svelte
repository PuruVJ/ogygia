<script lang="ts">
	// One post — data + prebaked body region over the `post` remote (HTML-only ticket, csr=false).
	import { page } from '$app/state';
	import { Region } from 'ogygia';
	import { post } from '$lib/blog.remote';

	const view = (await post(page.params.slug!))!;

	const pretty = (iso: string) =>
		new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'long',
			day: 'numeric',
			timeZone: 'UTC'
		});
</script>

<svelte:head>
	<title>{view.data.title} • Svelte Blog</title>
	{#if view.data.description}<meta name="description" content={view.data.description} />{/if}
</svelte:head>

<article class="blog-post og-article">
	<header>
		{#if view.date}<p class="date">{pretty(view.date)}</p>{/if}
		<h1>{view.data.title}</h1>
		{#if view.data.description}<p class="standfirst">{view.data.description}</p>{/if}
		{#if view.data.author}
			<p class="byline">
				{#if view.data.authorURL}<a href={view.data.authorURL}>{view.data.author}</a>{:else}{view.data.author}{/if}
			</p>
		{/if}
	</header>

	{#if view.body}
		<div class="og-body">
			<Region of={view.body} />
		</div>
	{/if}
</article>

<style>
	.blog-post {
		max-width: 80rem;
		margin: 0 auto;
		padding: var(--sk-page-padding-top) var(--sk-page-padding-side) var(--sk-page-padding-bottom);
	}
	header {
		margin-bottom: 4rem;
	}
	.date {
		font: var(--sk-font-ui-small);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sk-fg-4);
		margin: 0 0 1rem;
	}
	h1 {
		font: var(--sk-font-h1);
		margin: 0 0 1.2rem;
	}
	.standfirst {
		font: var(--sk-font-body);
		font-size: 2rem;
		color: var(--sk-fg-3);
		margin: 0 0 1rem;
	}
	.byline {
		font: var(--sk-font-ui-small);
		color: var(--sk-fg-4);
	}
	.byline a {
		color: inherit;
	}
</style>
