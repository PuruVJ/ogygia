import { site } from '$lib/docs';

// The prerendered search index — section documents the client worker indexes with Orama. Static, so
// the sidebar's search is instantaneous and on-device (no per-keystroke network, no server build).
export const prerender = true;

export const GET = site.emit.search();
