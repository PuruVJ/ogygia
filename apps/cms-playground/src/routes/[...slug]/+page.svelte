<script lang="ts">
	import { page } from '$app/state';
	import { Doc } from 'ogygia/content';
	import { site, preview_ctx } from '$lib/cms';

	// csr=false: the block body renders in this page's own SSR pass, so the Counter island inside
	// hydrates. `+page.ts` already 404'd unknown slugs. Pass the SAME preview context the load guard
	// derived, so a draft opened with `?preview=secret` renders instead of 404ing.
	const view = (await site.doc(page.params.slug ?? '', { context: preview_ctx(page.url) }))!;
</script>

<Doc {view} />
