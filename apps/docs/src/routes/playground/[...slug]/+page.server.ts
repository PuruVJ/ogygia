import { docs } from '$lib/playground/docs.server';

// The three-file mount: page options are literal + yours; the functions come off the site mint.
export const prerender = true;
export const load = docs.load;
export const entries = docs.entries;
