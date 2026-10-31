import { json } from '@sveltejs/kit';

export const prerender = false;

/** A deliberately slow upstream service: answers after `?ms` of latency. */
export const GET = async ({ url }: { url: URL }) => {
	const ms = Math.min(Math.max(Number(url.searchParams.get('ms')) || 300, 0), 4000);
	const name = url.searchParams.get('name') ?? 'svc';
	await new Promise((r) => setTimeout(r, ms));
	return json({ name, ms, at: 'now' });
};
