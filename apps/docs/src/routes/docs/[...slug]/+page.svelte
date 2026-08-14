<script lang="ts">
	import { page } from '$app/state';
	import { Doc } from 'ogygia/pharos';
	import type { DocView } from 'ogygia/pharos';
	import type { DocData } from '$lib/collections.server';
	import { doc } from '$lib/docs.remote';
	import PageHead from '$lib/PageHead.svelte';
	import '$lib/styles/pharos-docs.css';
	import '$lib/styles/code-block.css';

	// Dogfood the `.server.ts` rule: the component imports the `doc` REMOTE, never the collection.
	// `doc` bakes the entry's body into a region ticket (`<Doc>` renders it via `<Region>`); the
	// `.svx` demos inside wake from the baked HTML exactly as an in-pass render would. csr=false.
	const view = (await doc(page.params.slug ?? ''))! as DocView<DocData>;
	const data = view.entry.data;
</script>

<PageHead title={data.title} category={view.section} description={data.summary} />

<Doc {view} crumbs={false} keepReading={view.trail?.related} />
