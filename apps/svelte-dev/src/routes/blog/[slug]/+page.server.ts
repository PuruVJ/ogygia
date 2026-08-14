import { error } from '@sveltejs/kit';
import type { EntryGenerator } from './$types';
import { blog } from '$lib/site.server';

// Every post slug — the prerender source. The body itself crosses via the `post` remote.
export const prerender = true;
export const entries: EntryGenerator = async () => (await blog.refs()).map((r) => ({ slug: r.id }));

export const load = async ({ params }: { params: { slug: string } }) => {
	const refs = await blog.refs();
	if (!refs.some((r) => r.id === params.slug)) error(404, 'Not found');
	return {};
};
