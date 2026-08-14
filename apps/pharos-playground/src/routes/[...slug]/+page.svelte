<script lang="ts">
	import { page } from '$app/state';
	import { Doc } from 'ogygia/pharos';
	import { site } from '$lib/docs';

	// csr=false: the entry body renders in this page's own SSR pass, so islands inside the .svx
	// hydrate. `+page.ts` already 404'd unknown slugs, so the view is guaranteed here.
	const view = (await site.doc(page.params.slug ?? ''))!;
</script>

<Doc {view} />
