import { docs } from '$lib/site.server';

// The prerendered search index — section documents the client worker indexes with Orama, on-device.
// Dimensions-aware: the canonical (deduped) address set across the topic matrix.
export const prerender = true;

export const GET = docs.emit.search();
