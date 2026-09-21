import { json } from '@sveltejs/kit';

export const prerender = false;

/** A slow upstream service: answers after `?ms` of latency with a small payload. */
export const GET = async ({ url, params }: { url: URL; params: { name: string } }) => {
	const ms = Math.min(Math.max(Number(url.searchParams.get('ms')) || 30, 0), 2000);
	await new Promise((r) => setTimeout(r, ms));
	// the upstream's own split of its time — the profiler reads Server-Timing off every response
	// and draws it inside the wait ("their side: db 30 ms, render 8 ms")
	const timing = `db;dur=${Math.round(ms * 0.7)};desc="postgres", render;dur=${Math.round(ms * 0.2)}, cache;dur=0;desc="miss"`;
	if (params.name === 'recs') {
		const f = url.searchParams.get('for') ?? 'P0';
		return json({ name: 'recs', items: Array.from({ length: 6 }, (_, i) => `${f} + accessory ${i}`) }, { headers: { 'server-timing': timing } });
	}
	return json({ name: params.name, ms, payload: 'x'.repeat(2048) }, { headers: { 'server-timing': timing } });
};
