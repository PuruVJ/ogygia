<script lang="ts">
	import { page } from '$app/state';
	import { Region } from 'ogygia';
	import { docs } from '$lib/collections';
	import { sectionLabel } from '$lib/toc-items';
	import PageHead from '$lib/PageHead.svelte';
	import PageToc from '$lib/PageToc.svelte' with { wake: 'load' };
	import '$lib/styles/doc-page.css';
	import '$lib/styles/code-block.css';

	const slug = page.params.slug ?? '';
	// Server-only (csr=false): the entry's body is an inline partial, rendered in this page's own
	// SSR pass, so islands inside the .svx hydrate normally. `+page.ts` already 404'd an unknown
	// slug, so the entry is guaranteed here.
	const entry = (await docs.get(slug))!;
	// Section label comes from the slug (FS-derived), not frontmatter.
	const section = sectionLabel(slug);

	// "Keep reading" comes from the content graph: `related` frontmatter → entry.rel.related. If a
	// page lists none, fall back to the next page in reading order so EVERY page gets a trail.
	type Ref = { id: string; data: { title: string; summary?: string } };
	const declared = ((entry.rel?.related as Ref[] | undefined) ?? []).filter(Boolean);
	// Computed once for this csr=false render — a `const` (not a reassigned `let`) so Svelte doesn't
	// flag a non-reactive update.
	async function nextInOrder(): Promise<Ref[]> {
		const all = await docs.entries();
		const i = all.findIndex((e: { id: string }) => e.id === slug);
		const next = i >= 0 ? all[i + 1] : undefined;
		return next ? [{ id: next.id, data: next.data }] : [];
	}
	const keepReading: Ref[] = declared.length ? declared : await nextInOrder();
</script>

<PageHead title={entry.data.title} category={section} description={entry.data.summary} />

<div class="doc-layout">
	<main class="doc-main">
		<article class="doc-article">
			<p class="doc-eyebrow">{section}</p>
			<h1 class="doc-title">{entry.data.title}</h1>
			<div class="doc-body">
				<Region of={entry.body} />
			</div>
			{#if keepReading.length}
				<nav class="doc-next" aria-label="Keep reading">
					<p class="doc-next-eyebrow">Keep reading</p>
					<ul class="doc-next-list">
						{#each keepReading as r (r.id)}
							<li>
								<a class="doc-next-card" href={`/docs/${r.id}`}>
									<span class="doc-next-title">{r.data.title}</span>
									{#if r.data.summary}<span class="doc-next-summary">{r.data.summary}</span>{/if}
								</a>
							</li>
						{/each}
					</ul>
				</nav>
			{/if}
		</article>
	</main>
	<aside class="doc-aside">
		<PageToc headings={entry.meta.headings} />
	</aside>
</div>
