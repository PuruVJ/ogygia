import { count_render } from '$lib/server/state.js';

/** The holes page: a pure shell (stores) with a `render:'deferred'` island inside — the hole
 *  fetches fresh per request while the shell is served from the store. PPR semantics. */
export function load({ url }) {
	return { render: count_render(url.pathname) };
}
