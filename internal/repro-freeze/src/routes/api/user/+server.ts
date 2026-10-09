import { redirect } from '@sveltejs/kit';

/** One-click demo login: `?name=X` sets the user cookie, no name clears it, then back to the
 *  live-header page. (An /api route — never storable, content-type aside: it redirects.) */
export function GET({ url, cookies }) {
	const name = url.searchParams.get('name');
	if (name) cookies.set('user', name, { path: '/' });
	else cookies.delete('user', { path: '/' });
	redirect(303, '/fr/fr/live-header');
}
