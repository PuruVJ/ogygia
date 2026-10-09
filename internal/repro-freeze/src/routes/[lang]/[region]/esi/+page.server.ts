import { count_render } from '$lib/server/state.js';

/** The EDGE stitching (ESI) demo shell: PURE (stores, stays edge-cacheable). The header inside is a
 *  `stitch: 'edge'` deferred hole — the capture rewrites it into an ESI include the CDN fills per
 *  request; origin renders only the hole, the shell is served from the edge cache. */
export function load({ url }) {
	return { render: count_render(url.pathname) };
}
