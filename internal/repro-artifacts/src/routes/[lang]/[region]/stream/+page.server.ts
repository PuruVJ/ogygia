import { count_render } from '$lib/server/state.js';

/** Never-store guard: a streamed load promise → always per-request. */
export function load({ url }) {
	const n = count_render(url.pathname);
	return {
		render: n,
		slow: new Promise<string>((res) => setTimeout(() => res('streamed value'), 40))
	};
}
