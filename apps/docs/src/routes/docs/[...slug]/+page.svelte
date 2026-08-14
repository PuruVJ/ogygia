<script lang="ts">
	import { page } from '$app/state';
	import { Doc } from 'ogygia/pharos';
	import { site } from '$lib/docs';
	import type { DocData } from '$lib/collections';
	import type { DocView } from 'ogygia/pharos';
	import PageHead from '$lib/PageHead.svelte';
	import '$lib/styles/pharos-docs.css';
	import '$lib/styles/code-block.css';

	const slug = page.params.slug ?? '';
	// Dogfood: the page body is pharos's `<Doc>` brick, fed by `site.doc()`. csr=false — the entry
	// body renders in this page's own SSR pass so islands inside the .svx hydrate. `+page.ts` already
	// 404'd unknown slugs. `keepReading` = curated `related` (the pager owns sequential order).
	const view = (await site.doc(slug, { base: '/docs' }))! as DocView<DocData>;
	const data = view.entry.data;
</script>

<PageHead title={data.title} category={view.section} description={data.summary} />

<Doc {view} crumbs={false} keepReading={view.trail.related} />
