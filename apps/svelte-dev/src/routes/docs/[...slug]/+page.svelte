<script lang="ts">
	import { page } from '$app/state';
	import { Doc } from 'ogygia/content';
	import type { PageView } from 'ogygia/content';
	import * as docs from '$lib/docs.remote'; // namespace: `page` would clash with $app/state
	import { TOPICS, topicFromPath, type DocData } from '$lib/topics';

	const slug = page.params.slug ?? '';
	// The page over ogygia's `page` remote — the entry's lazy body rides the wire as a region ticket
	// (transport hook) and <Doc>'s <Region> renders it. +page.ts already 404'd unknown slugs.
	const view = (await docs.page(slug))! as PageView<DocData>;
	const data = view.entry.data;

	// svelte.dev's eyebrow is "TOPIC • SECTION" — the dimension coordinate joins the section label.
	const topic = TOPICS.find((t) => t.key === topicFromPath(page.url.pathname))!;
	const eyebrow = view.section ? `${topic.label} • ${view.section}` : topic.label;

	// "Edit this page on GitHub" — back to the ACTUAL source repo the git() loader pulled from.
	const repo = topic.key === 'svelte' ? 'svelte' : topic.key === 'ai' ? 'ai-tools' : topic.key;
	const bare = topic.key === 'svelte' ? slug : slug.split('/').slice(1).join('/');
	const editHref = `https://github.com/sveltejs/${repo}/tree/main/documentation/docs`;
	void bare;
</script>

<svelte:head><title>{data.title || slug} • Docs • Svelte</title></svelte:head>

<Doc {view} crumbs={false} suggested={false} {eyebrow}>
	{#snippet footer()}
		<a href={editHref}>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
			Edit this page on GitHub
		</a>
		<a href="/llms.txt">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
			llms.txt
		</a>
	{/snippet}
</Doc>
