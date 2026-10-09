import { redirect } from '@sveltejs/kit';
import { count_render } from '$lib/server/state.js';

/** Stored-redirect page (the bcms PDP 301 shape): permanent-canonical → the REDIRECT stores. */
export function load({ url, params }) {
	count_render(url.pathname);
	redirect(301, `/${params.lang}/${params.region}/c/home`);
}
