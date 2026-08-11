import { error } from '@sveltejs/kit';
import { builderPages } from '$lib/builder/pages';

export async function load({ params }) {
	if (!(await builderPages.get(params.page ?? ''))) error(404, 'Page not found');
}
