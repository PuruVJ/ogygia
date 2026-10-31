// PLANTED redirect: 1.1 s before it sends the browser on to the (fast) page — the redirect is most
// of the page's first byte then.
import { redirect } from '@sveltejs/kit';

export const GET = async () => {
	await new Promise((ok) => setTimeout(ok, 1100));
	redirect(302, '/dt-ttfb?fast');
};
