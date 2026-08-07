<script lang="ts">
	import PermalinkHeading from '$lib/PermalinkHeading.svelte';
	import Contours from '$lib/Contours.svelte';
	import PageHead from '$lib/PageHead.svelte';

	const cards = [
		{
			href: '/playground/strategies',
			eyebrow: 'hydrate',
			title: 'Strategies',
			body: 'load, idle, visible, media, and a named preset — each a live island with a JS-off toggle so you can see the static HTML the server shipped.'
		},
		{
			href: '/playground/server-islands',
			eyebrow: 'defer',
			title: 'Server islands',
			body: 'Deferred holes fetched on four schedules, a visible hole below the fold, and cookie personalization rendered on the server.'
		},
		{
			href: '/playground/lakes',
			eyebrow: "hydrate: 'none'",
			title: 'Lakes',
			body: 'A frozen region inside an interactive island, remount cache vs SWR revalidate, and an island that wakes up again inside a lake.'
		},
		{
			href: '/playground/data',
			eyebrow: '.remote.ts',
			title: 'Data & remotes',
			body: 'query seeded from SSR, command + refresh, a live SSE clock, batched queries, and a remote form() guestbook.'
		},
		{
			href: '/playground/router',
			eyebrow: 'OgygiaRouter',
			title: 'Router',
			body: 'SPA swaps with view transitions, data-ogygia-persist chrome that keeps islands mounted, prefetch attributes, plus an MPA handoff.'
		},
		{
			href: '/playground/on-demand',
			eyebrow: 'await import()',
			title: 'Client-only lazy mount',
			body: 'Host island dynamically imports a plain Svelte component on click — regular child, not a second island. import() + with { hydrate } stays a build error.'
		},
		{
			href: '/playground/portable',
			eyebrow: 'ogygia 0.4',
			title: 'Portable bindings',
			body: 'Marked imports are values — stash them in a dictionary or barrel, pick one with ?widget=, render with <Active />. Controls stay a separate island with serializable props only.'
		},
		{
			href: '/playground/mutation-guard',
			eyebrow: 'dev warning',
			title: 'Mutation guard',
			body: 'Captured host state is a one-way snapshot. Mutating it in an island is a no-op the dev runtime warns about.'
		}
	];
</script>

<PageHead
	title="Playground"
	description="Live demos of ogygia’s region model — hydrate strategies, server islands, lakes, remotes, and the SPA router."
/>

<header class="shell pg-hero">
	<Contours class="pg-hero-contours" />
	<div class="pg-hero-copy">
		<span class="eyebrow">Playground</span>
		<h1>Playground</h1>
		<p class="pg-lede">
			Working demos of every part of the region model, running on this docs site as real
			<code>csr = false</code> island shells. Each page is honest: it does exactly what it says, and
			the JS-off toggles let you see the static HTML underneath.
		</p>
		<div class="btn-row">
			<a class="btn btn--primary" href="/playground/strategies">Start with strategies</a>
			<a class="btn btn--ghost" href="/">Read the docs</a>
		</div>
	</div>
</header>

<main class="shell pg-grid-wrap">
	<div class="pg-grid">
		{#each cards as card}
			<a class="pg-card" href={card.href}>
				<span class="eyebrow">{card.eyebrow}</span>
				<h2 class="pg-card-title">{card.title}</h2>
				<p class="pg-card-body">{card.body}</p>
				<span class="pg-card-go">Open demo →</span>
			</a>
		{/each}
	</div>
</main>

<style>
	.pg-hero {
		position: relative;
		overflow: clip;
		padding-top: 1rem;
		padding-bottom: 3rem;
	}
	.pg-hero-copy {
		position: relative;
		z-index: 1;
		max-width: 46rem;
	}
	.pg-lede {
		font-size: 1.0625rem;
		max-width: 54ch;
	}
	.pg-grid-wrap {
		padding-bottom: 2rem;
	}
	.pg-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 1.25rem;
	}
	.pg-card {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1.5rem;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		background: var(--bg-raised);
		box-shadow: var(--shadow-panel);
		color: var(--text);
		transition:
			border-color 120ms ease,
			transform 160ms cubic-bezier(0.2, 0.7, 0.2, 1);
	}
	.pg-card:hover {
		border-color: var(--accent-line);
		transform: translateY(-2px);
	}
	.pg-card-title {
		margin: 0;
		font-size: 1.5rem;
		line-height: 1.1;
	}
	.pg-card-body {
		margin: 0;
		color: var(--text-dim);
		font-size: 0.9375rem;
		flex: 1;
	}
	.pg-card-go {
		margin-top: 0.5rem;
		font: 500 0.8125rem/1 var(--font-mono);
		color: var(--accent);
	}

	:global(.pg-hero-contours) {
		position: absolute;
		top: 50%;
		right: -140px;
		width: min(460px, 50vw);
		transform: translateY(-50%);
		opacity: 0.3;
		pointer-events: none;
		color: var(--line-strong);
	}

	@media (max-width: 1023px) {
		:global(.pg-hero-contours) {
			opacity: 0.18;
			right: -280px;
		}
	}
</style>
