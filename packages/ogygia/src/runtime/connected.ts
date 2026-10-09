/**
 * Every region currently CONNECTED to the live document (added at connect, removed at disconnect —
 * shadow-rooted ones included, a custom element connects wherever it is). The navigation compares
 * its size to the light DOM's region count: a mismatch means a region lives inside a shadow root,
 * where a body morph cannot reach it, and the navigation takes the full-swap path. A count, not
 * the `'*'` walk over every element the old shadow-root probe made on each navigation. Its own
 * module: the element (core) writes it, the lazily loaded navigation reads it, and neither needs
 * the other's imports for that.
 */
export const connected_regions = new Set<Element>();

/** Is any connected region inside a shadow root (so a body morph would miss it)? */
export function regions_in_shadow(): boolean {
	return connected_regions.size !== document.body.querySelectorAll('ogygia-region').length;
}
