<script lang="ts">
	import { page } from '$app/state';
	import { Region } from 'ogygia';
	import { builderPages } from '$lib/builder/pages';

	// Server-only (csr=false): the entry's body is an inline partial rendered in this page's own SSR
	// pass, so the interactive block inside it self-hydrates. `+page.ts` already 404'd unknown pages.
	const slug = page.params.page ?? '';
	const entry = (await builderPages.get(slug))!;
</script>

<main class="builder-page">
	<p class="builder-tag">Builder.io → ogygia · <code>/demo/builder/{slug}</code></p>
	<Region of={entry.body} />
</main>

<style>
	.builder-page {
		max-width: 44rem;
		margin: 0 auto;
		padding: 2rem 1.25rem 4rem;
		display: grid;
		gap: 1rem;
	}
	.builder-tag {
		font-size: 0.8rem;
		opacity: 0.6;
		margin: 0;
	}
	.builder-tag code {
		font-size: 0.85em;
	}
</style>
