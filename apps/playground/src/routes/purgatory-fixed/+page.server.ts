// PURGATORY, FIXED — /purgatory with the profiler's COUNTED fixes applied, to hold its forecast to
// account: the catalog's tags computed once at startup (which takes the copying loop inside it out of
// the request too), the price formatter built once per currency. Left as they were, because the
// forecast does not count them: the random stamps, the request's own sort, the item spreads.
// (No PATTERN comments: this page measures the forecast.)
import { randomUUID } from 'node:crypto';
import { BRANDS, PRODUCTS } from '$lib/inferno/data';
import { allTags, flatten, initials, isSlugSafe, priceCached, sortByName, withDiscount } from '$lib/purgatory/helpers';
import type { PageServerLoad } from './$types';

export const prerender = false;

function stamped(ids: string[]): string[] {
	return ids.map((id) => `${id}:${randomUUID()}`);
}

// the same on every request: computed once, at startup
const tags = allTags(PRODUCTS.slice(0, 1500));

export const load: PageServerLoad = async ({ url }) => {
	const q = url.searchParams.get('q') ?? '';
	// (the catalog fetch stays: keeping an answer is a freshness decision, not a counted code fix)
	const catalog = await (await fetch(`${url.origin}/hell/api/catalog?ms=25`)).json();
	const stamps = stamped(PRODUCTS.slice(0, 3000).map((p) => p.id));
	const catalogRows = await Promise.resolve(PRODUCTS.filter((p) => p.name.length > q.length));
	const sorted = sortByName(catalogRows);
	const listed = sorted.slice(0, 800).map((p) => priceCached(p.price, p.currency));
	const cached = sorted.slice(0, 800).map((p) => priceCached(p.price, p.currency));
	const sale = withDiscount(sorted);
	const flat = flatten(sorted.map((p) => p.tags));
	const slugged = BRANDS.filter((b) => isSlugSafe(b.name.toLowerCase().replaceAll(' ', ''))).length;
	const inits = sorted.map((p) => initials(p.name));
	return {
		q,
		tags: tags.length,
		stamps: stamps.length,
		listed: listed.slice(0, 3),
		cached: cached.slice(0, 3),
		sale: sale.length,
		flat: flat.length,
		count: sorted.length,
		slugged,
		items: catalog.items.length as number,
		inits: inits.slice(0, 3),
		shelf: sorted.slice(0, 400).map((p) => ({ id: p.id, name: p.name, price: p.price }))
	};
};
