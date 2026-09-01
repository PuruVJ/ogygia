import { count_render } from '$lib/server/state.js';

/** Never-store guard: the render WRITES a cookie → always per-request. */
export function load({ url, cookies }) {
	const n = count_render(url.pathname);
	cookies.set('seen', '1', { path: '/' });
	return { render: n };
}
