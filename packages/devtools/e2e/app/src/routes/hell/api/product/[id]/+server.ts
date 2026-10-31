import { json } from '@sveltejs/kit';

export const prerender = false;

/** The N+1 target: one product's live stock, `?ms` of latency each. */
export const GET = async ({ url, params }: { url: URL; params: { id: string } }) => {
	const ms = Math.min(Math.max(Number(url.searchParams.get('ms')) || 6, 0), 500);
	await new Promise((r) => setTimeout(r, ms));
	return json({ id: params.id, stock: (params.id.length * 7) % 40 });
};
