import { docs } from '$lib/site.server';

// The no-JS results page reads `?q=` — a runtime concern; everything else prerenders.
export const prerender = false;

export const load = async ({ url }: { url: URL }) => {
	const q = url.searchParams.get('q') ?? '';
	const hits = q ? await docs.search(q, { base: '/docs' }) : [];
	return { q, hits };
};
