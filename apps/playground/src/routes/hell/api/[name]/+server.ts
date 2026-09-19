import { json } from '@sveltejs/kit';

export const prerender = false;

/** A slow upstream service: answers after `?ms` of latency with a small payload. */
export const GET = async ({ url, params }: { url: URL; params: { name: string } }) => {
	const ms = Math.min(Math.max(Number(url.searchParams.get('ms')) || 30, 0), 2000);
	await new Promise((r) => setTimeout(r, ms));
	if (params.name === 'recs') {
		const f = url.searchParams.get('for') ?? 'P0';
		return json({ name: 'recs', items: Array.from({ length: 6 }, (_, i) => `${f} + accessory ${i}`) });
	}
	return json({ name: params.name, ms, payload: 'x'.repeat(2048) });
};
