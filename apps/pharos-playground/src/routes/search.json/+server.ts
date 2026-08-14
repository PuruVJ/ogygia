import { site } from '$lib/docs';

// The prerendered client search index (section documents the on-device Orama worker indexes). Static,
// so ⌘K search is instantaneous with no per-keystroke network. Convention path: `{base}/search.json`.
export const prerender = true;

export const GET = site.emit.search();
