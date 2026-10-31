// LATECOMER, FIXED — /latecomer with the profiler's fixes applied, to hold its forecast to account:
// the reviews and the slow recommendations moved into deferred islands that fetch their own data,
// so the load waits only for what the first byte shows. The answer key profiles both pages and
// compares /latecomer's forecast with this page's measured render.
import type { PageServerLoad } from './$types';

export const prerender = false;

async function get(origin: string, name: string, ms: number): Promise<{ name: string; ms: number }> {
	const res = await fetch(`${origin}/hell/api/${name}?ms=${ms}`);
	return res.json();
}

export const load: PageServerLoad = async ({ url, fetch }) => {
	const origin = url.origin;
	const price = await (await fetch(`${origin}/hell/api/live?ms=20`)).json();
	const [nav, crumbs] = await Promise.all([get(origin, 'nav', 10), get(origin, 'crumbs', 12)]);
	return { title: 'Latecomer', price, nav, crumbs };
};
