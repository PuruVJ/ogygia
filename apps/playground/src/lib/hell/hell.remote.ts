import { query, getRequestEvent } from '$app/server';
import { span } from 'ogygia/profiler';

// A remote function awaited DURING the page's SSR (PriceTicker's top-level await): it runs
// in-process, waits on a "pricing service" round trip, and is on the render's critical path —
// the profiler's "remote functions" phase. The span names the part the hooks cannot see.
export const stockSummary = query(async () => {
	const { url } = getRequestEvent();
	const res = await fetch(`${url.origin}/hell/api/stock-summary?ms=22`);
	const j = (await res.json()) as { ms: number };
	await span('cache.write', () => new Promise((r) => setTimeout(r, 12)));
	return { low: 7, out: 3, refreshed_ms: j.ms };
});
