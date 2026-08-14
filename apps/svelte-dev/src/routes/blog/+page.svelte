<script lang="ts">
	// svelte.dev's blog index — a dated list, newest first, grouped by year.
	let { data } = $props();

	const years = $derived.by(() => {
		const map = new Map<string, typeof data.posts>();
		for (const p of data.posts) {
			const y = p.date!.slice(0, 4);
			if (!map.has(y)) map.set(y, []);
			map.get(y)!.push(p);
		}
		return [...map.entries()];
	});

	const pretty = (iso: string) =>
		new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC'
		});
</script>

<svelte:head>
	<title>Blog • Svelte</title>
	<meta name="description" content="Articles about Svelte and UI development" />
</svelte:head>

<div class="blog-index">
	<h1>Blog</h1>

	{#each years as [year, posts] (year)}
		<section>
			<h2>{year}</h2>
			<ul>
				{#each posts as p (p.slug)}
					<li>
						<a href="/blog/{p.slug}">
							<span class="date">{pretty(p.date!)}</span>
							<span class="text">
								<span class="title">{p.title}</span>
								{#if p.description}<span class="description">{p.description}</span>{/if}
							</span>
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
</div>

<style>
	.blog-index {
		max-width: var(--sk-page-content-width);
		margin: 0 auto;
		padding: var(--sk-page-padding-top) var(--sk-page-padding-side) var(--sk-page-padding-bottom);
	}
	h1 {
		font: var(--sk-font-h1);
		margin-bottom: 4rem;
	}
	h2 {
		font: var(--sk-font-h3);
		color: var(--sk-fg-3);
		margin: 4rem 0 1.6rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li a {
		display: grid;
		grid-template-columns: 8rem 1fr;
		gap: 1.6rem;
		padding: 1rem 0;
		text-decoration: none;
		color: inherit;
	}
	.date {
		font: var(--sk-font-ui-small);
		color: var(--sk-fg-4);
		padding-top: 0.4rem;
		font-variant-numeric: tabular-nums;
	}
	.text {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.title {
		font: var(--sk-font-h4, var(--sk-font-ui-large));
		font-size: 2rem;
		color: var(--sk-fg-1);
	}
	li a:hover .title {
		color: var(--sk-fg-accent);
	}
	.description {
		font: var(--sk-font-body-small);
		color: var(--sk-fg-3);
	}
	@media (max-width: 600px) {
		li a {
			grid-template-columns: 1fr;
			gap: 0.3rem;
		}
	}
</style>
