import { error, json } from '@sveltejs/kit';
import { find_page, page_id } from '$lib/server/db';

/** `GET /api/pages/{category}/{slug}` → one full page (with body), 404 when absent. */
export const GET = ({ params }) => {
	const page = find_page(params.id ?? '');
	if (!page) error(404, 'no such page');
	return json({ id: page_id(page), ...page });
};
