import { count_render } from '$lib/server/state.js';

/** The serve-time stitching demo shell: PURE (stores). The header inside is a `stitch: 'serve'`
 *  deferred hole — every serve renders it server-side with the visitor's cookies and splices
 *  it into the stored bytes: personalized in view-source, on a page that never re-renders. */
export function load({ url }) {
	return { render: count_render(url.pathname) };
}
