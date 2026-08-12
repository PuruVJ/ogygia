import { error } from '@sveltejs/kit';
import { pages } from '$lib/blocks/pages';

export async function load() {
	const page = await pages.get('landing');
	if (!page) error(404, 'no landing page');
	return { page };
}
