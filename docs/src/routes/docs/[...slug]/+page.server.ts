import type { EntryGenerator } from './$types';
import { docs } from '$lib/collections';

// Server-only: keeps the $app/server-coupled collection out of the browser graph.
// Each doc page is static HTML with live island holes; csr=false is inherited from the root layout.
export const prerender = true;

/** Enumerate every visible doc slug so the crawler prerenders them all. */
export const entries: EntryGenerator = async () => (await docs.ids()).map((slug) => ({ slug }));
