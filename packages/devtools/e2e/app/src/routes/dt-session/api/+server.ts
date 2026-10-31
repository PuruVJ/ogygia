// PLANTED server-time (the Record tab's key): this endpoint waits on an upstream call for most of
// its time; the profiler's Server-Timing header names it, and the Record tab shows the split.
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, fetch }) => {
	const ms = Math.min(2000, Number(url.searchParams.get('ms')) || 450);
	const upstream = await fetch(`/hell/api/session?ms=${ms}&from=dt-session-api`);
	await upstream.text();
	return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
};
