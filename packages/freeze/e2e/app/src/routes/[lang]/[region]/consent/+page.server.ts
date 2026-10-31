import { count_render } from '$lib/server/state.js';

/** The vary-bucket law page: reads a consent cookie WITH a default. Anonymous (no cookie) →
 *  the read returns undefined = DEFAULT → this page still stores (the canonical render).
 *  A visitor who set the cookie → non-default read → that request stays per-request. */
export function load({ url, cookies }) {
	const n = count_render(url.pathname);
	const consent = cookies.get('consent') ?? 'none';
	return { consent, render: n };
}
