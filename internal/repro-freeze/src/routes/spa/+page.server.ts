import { count_render } from '$lib/server/state.js';

export function load({ url }) {
	return { render: count_render(url.pathname) };
}
