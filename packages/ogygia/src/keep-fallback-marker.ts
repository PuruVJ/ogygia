/**
 * The parcel/store stand-in for "keep the fallback" (see ./keep-fallback.ts) — never applied to the
 * DOM. A dependency-free leaf: the browser runtime's boot compares a hole's answer against it, and
 * `keep-fallback.ts` itself imports the server-side context module (which reaches Svelte), which must
 * never enter the boot's static graph.
 */
export const KEEP_FALLBACK_HTML = '<!--ogygia:keep-fallback-->';
