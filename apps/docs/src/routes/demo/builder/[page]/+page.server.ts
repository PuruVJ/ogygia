import type { EntryGenerator } from './$types';
import { builderPages } from '$lib/builder/pages';

// Static HTML with live island holes; csr=false inherited from the root layout. Server-only keeps
// the collection out of the browser graph.
export const prerender = true;

/** Prerender every Builder page. */
export const entries: EntryGenerator = async () => (await builderPages.ids()).map((page) => ({ page }));
