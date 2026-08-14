import { site } from '$lib/site.server';

// The no-JS results page reads `?q=` — a runtime concern; everything else prerenders.
export const prerender = false;

export const load = async ({ url }: { url: URL }) => {
	const q = url.searchParams.get('q') ?? '';
	const hits = q ? await site.search(q, { base: '/docs' }) : [];
	return { q, hits };
};
