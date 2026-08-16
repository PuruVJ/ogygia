import type { EntryGenerator } from './$types';
import { docs } from '$lib/docs.server';

// Each doc page is static HTML with live island holes; csr=false is inherited from the root layout.
export const prerender = true;

// The ogygia 404 guard, server-side: a 404 thrown from load maps to a real status (from the
// component's top-level await it would escalate to a 500). The page body itself comes from the
// `doc` remote in the component — a baked region ticket, so the corpus never enters the client.
export const load = docs.load;

/** Every leaf slug in the ogygia outline — the prerender source (identical set to `docs.ids()`). */
export const entries: EntryGenerator = docs.entries;
