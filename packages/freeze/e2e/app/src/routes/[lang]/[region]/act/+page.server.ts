import { count_render } from '$lib/server/state.js';

let tally = 0;

/** Action self-evict page: GET stores; a successful POST evicts its own URL (next GET re-renders). */
export function load({ url }) {
	const n = count_render(url.pathname);
	return { render: n, tally };
}

export const actions = {
	default: () => {
		tally += 1;
		return { ok: true };
	}
};
