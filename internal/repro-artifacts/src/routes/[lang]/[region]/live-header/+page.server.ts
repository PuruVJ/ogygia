import { count_render } from '$lib/server/state.js';

/** The live-header demo shell: PURE (stores as an artifact). The header inside is
 *  `render: 'live'` — baked into the stored bytes, self-freshening per visit with cookies. */
export function load({ url }) {
	return { render: count_render(url.pathname) };
}
