<script lang="ts">
	import { page } from '$app/state';
	import { nav } from '$lib/docs.remote';
	import { topicFromPath } from '$lib/topics';
	import type { NavGroup, NavLeaf } from 'ogygia/content';

	// KEPT island across body-swaps (scroll survives) → everything derives from the URL. The topic
	// (dimension coordinate) picks which prerendered tree `nav()` serves. The topic SWITCHER lives in
	// the header's Docs popup, not here (svelte.dev's model) — the sidebar is one topic's tree.
	const path = $derived(decodeURIComponent(page.url.pathname));
	const topic = $derived(topicFromPath(path));
	const groups = $derived(
		(await nav(topic === 'svelte' ? '' : topic + '/'))
			.filter((n): n is NavGroup => n.kind === 'group')
			.map((g) => ({ label: g.label, items: g.items.filter((i): i is NavLeaf => i.kind === 'leaf') }))
	);
</script>

<nav class="sidebar" aria-label="Docs">
	<ul class="sections">
		{#each groups as group (group.label)}
			<li class="section">
				<h3>{group.label}</h3>
				<ul class="pages">
					{#each group.items as item (item.href)}
						{@const current = path === decodeURIComponent(item.href)}
						<li class="page-item" class:current>
							<a class="page" href={item.href} aria-current={current ? 'page' : undefined}>{item.title}</a>
						</li>
					{/each}
				</ul>
			</li>
		{/each}
	</ul>
</nav>

<style>
	/* svelte.dev's docs sidebar: body-serif rhythm, serif section headings, accent+underline current
	   page, and the diamond marker straddling the content boundary at the current item. */
	.sidebar {
		font-family: var(--sk-font-family-body);
		padding: var(--sk-page-padding-top) 0.5rem 6rem 3.2rem;
	}
	/* right-align the nav against the content boundary when the column is wider than the menu */
	@media (min-width: 832px) {
		.sidebar {
			width: var(--sk-sidebar-width);
			margin-left: auto;
		}
	}

	.sections,
	.pages {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.section {
		position: relative;
		display: block;
		margin: 0 0 4rem 0;
		padding-right: 0.5rem;
	}
	.section:last-child {
		margin-bottom: 0;
	}

	h3 {
		margin: 0 0 0.3rem 0;
		font: var(--sk-font-h3);
		color: var(--sk-fg-1);
	}

	.page {
		display: block;
		font: var(--sk-font-body-small);
		color: inherit;
		text-decoration: none;
		padding: 0.15rem 0;
		transition: color 0.2s;
		user-select: none;
	}
	.page:hover {
		color: var(--sk-fg-1);
		text-decoration: none;
	}
	.page[aria-current='page'] {
		color: var(--sk-fg-accent);
		text-decoration: underline;
	}

	/* the rotated-square marker on the boundary at the current page (desktop only) */
	.page-item {
		position: relative;
	}
	@media (min-width: 832px) {
		/* svelte.dev's exact marker geometry: anchored to the row's first text line (not 50% of a
		   possibly-wrapped item), straddling the boundary the scrollport clips at. */
		.page-item.current::after {
			--size: 1.8rem;
			content: '';
			position: absolute;
			width: var(--size);
			height: var(--size);
			top: calc(1.4rem - var(--size) * 0.5);
			right: calc(-1rem - 0.5 * var(--size));
			background-color: var(--sk-bg-1);
			rotate: 45deg;
			box-shadow: 0 0 3px rgba(0, 0, 0, 0.12);
			z-index: 2;
		}
	}
</style>
