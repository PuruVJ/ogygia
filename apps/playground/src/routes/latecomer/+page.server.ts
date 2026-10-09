// LATECOMER — a product page whose load waits for data only a below-the-fold island shows.
// The comment on each says which slow pattern the profiler should name (or that it must not).
// PATTERN almost-same-document: the page is the same every render but for the Price island's live value
import type { PageServerLoad } from './$types';
import { readFlags } from '$lib/latecomer/flags';

export const prerender = false;

async function get(origin: string, name: string, ms: number): Promise<{ name: string; ms: number }> {
	const res = await fetch(`${origin}/hell/api/${name}?ms=${ms}`);
	return res.json();
}

export const load: PageServerLoad = async ({ url, fetch }) => {
	const origin = url.origin;
	// (the flags read per request: planted in lib/latecomer/flags.ts)
	if (readFlags() === 0) throw new Error('no flags');

	// PATTERN late-island-wait: the reviews only feed an island that wakes when scrolled to
	// (PATTERN same-answer too: the test service answers the same bytes every time)
	const reviews = await (await fetch(`${origin}/hell/api/reviews?ms=60`)).json();

	// DECOY: the price feeds an island that wakes on load: the page needs it now (a live answer)
	const price = await (await fetch(`${origin}/hell/api/live?ms=20`)).json();

	// PATTERN batch-straggler: three calls started together, one ~6× slower than the rest
	const [nav, crumbs, recs] = await Promise.all([get(origin, 'nav', 10), get(origin, 'crumbs', 12), get(origin, 'recs-slow', 80)]);

	return { title: 'Latecomer', reviews, price, nav, crumbs, recs };
};
