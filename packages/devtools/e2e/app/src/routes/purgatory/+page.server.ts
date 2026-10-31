// PURGATORY — an answer-key page for the profiler's newest rules: planted patterns in the shapes
// they were built for, and DECOYS for every false alarm those rules once raised. The comment on each
// says which slow pattern the profiler should name (or why it must stay quiet). Profile it:
// /__profiler → "Profile one page" → /purgatory, or `pnpm profiler:answer-key`.
import {
	randomUUID
} from 'node:crypto';
import { BRANDS, PRODUCTS } from '$lib/inferno/data';
import { allTags, catalogRows, flatten, initials, isSlug, priceCached, priceOf, sortByName, withDiscount } from '$lib/purgatory/helpers';
import type { PageServerLoad } from './$types';

export const prerender = false;

/** DECOY: a new random id on every call (imported over several lines): never the same every request */
function stamped(ids: string[]): string[] {
	return ids.map((id) => `${id}:${randomUUID()}`);
}

export const load: PageServerLoad = async ({ url }) => {
	const q = url.searchParams.get('q') ?? '';

	// PATTERN almost-same-answer: the catalog answers the same items every time, but stamps its generation time and a request id
	const catalog = await (await fetch(`${url.origin}/hell/api/catalog?ms=25`)).json();

	// PATTERN same-every-request: every tag of the catalog, from the module's own data, on every request
	const tags = allTags(PRODUCTS.slice(0, 1500));

	// DECOY: a random id per product: a new answer on every request, not a value to compute once
	const stamps = stamped(PRODUCTS.slice(0, 3000).map((p) => p.id));

	// DECOY: `catalogRows` here is this request's rows (it shadows the imported name): sorting them is per request
	const catalogRows = await Promise.resolve(PRODUCTS.filter((p) => p.name.length > q.length));
	const sorted = sortByName(catalogRows);

	const listed = sorted.slice(0, 800).map((p) => priceOf(p.price, p.currency));
	const cached = sorted.slice(0, 800).map((p) => priceCached(p.price, p.currency));
	const sale = withDiscount(sorted);
	const flat = flatten(sorted.map((p) => p.tags));
	// the brands whose name is already a slug (the check itself: $lib/purgatory/helpers.ts)
	const slugged = BRANDS.filter((b) => isSlug(b.name.toLowerCase().replaceAll(' ', ''))).length;
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
		// the shelf island's list (it reads page.data through a helper: see $lib/purgatory/shelf.ts)
		shelf: sorted.slice(0, 400).map((p) => ({ id: p.id, name: p.name, price: p.price }))
	};
};
