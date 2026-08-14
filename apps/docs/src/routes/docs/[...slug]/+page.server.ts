import type { EntryGenerator } from './$types';
import { site } from '$lib/docs';

// Each doc page is static HTML with live island holes; csr=false is inherited from the root layout.
export const prerender = true;

/** Every leaf slug in the pharos outline — the prerender source (identical set to `docs.ids()`). */
export const entries: EntryGenerator = site.entries;
