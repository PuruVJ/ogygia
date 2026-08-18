<script lang="ts">
	import { page } from '$app/state';
	import { Doc } from 'ogygia/content';
	import * as docs from '$lib/playground/docs.remote'; // namespace: `page` would clash with $app/state
	import OperationDoc from '$lib/playground/openapi/OperationDoc.svelte';
	import type { Operation } from '$lib/playground/openapi';

	// LEAK-FREE: the entry comes over the wire from the `page` remote (corpus stays server-only). The
	// `+page.server.ts` guard already 404'd unknown slugs, so the view is guaranteed. A markdown body
	// arrives as a baked region ticket; islands inside it wake normally.
	const view = (await docs.page(page.params.slug ?? ''))!;

	// The `/api` reference is OpenAPI operations (structured `data`, no markdown body) — detect them by
	// the `method` the openapi() source stamps on `meta`, and render with OperationDoc.
	const isOperation = $derived((view.entry.meta as { method?: string } | undefined)?.method != null);
</script>

{#if isOperation}
	<OperationDoc op={view.entry.data as unknown as Operation} />
{:else}
	<Doc {view} />
{/if}
