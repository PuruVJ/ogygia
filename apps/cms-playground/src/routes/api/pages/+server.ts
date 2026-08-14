import { json } from '@sveltejs/kit';
import { pages, page_id } from '$lib/server/db';

/** `GET /api/pages` → shallow rows (ids + order). `?full=1` includes bodies (the loader's list()). */
export const GET = ({ url }) => {
	const full = url.searchParams.get('full') === '1';
	return json(
		pages.map((p) => {
			const { body, ...rest } = p;
			return { id: page_id(p), ...rest, ...(full ? { body } : {}) };
		})
	);
};
