// LIMBO — an answer-key page for the profiler written the way an app is, not the way the rules were
// built: each planted pattern in a shape no other answer-key page uses, and beside it a DECOY that
// does the same job the right way. The comment on each (here and in $lib/limbo) says which slow
// pattern the profiler should name, or why it must stay quiet. Profile it: /__profiler → "Profile one
// page" → /limbo, or `node internal/bench/profiler-answer-key.mjs --page=/limbo`.
import { PRODUCTS } from '$lib/inferno/data';
import { brandOf, brandOfIndexed, onSale, onSaleShallow, reviewDates, reviewDatesShared, specDirect, specOf } from '$lib/limbo/helpers';
import type { PageServerLoad } from './$types';

export const prerender = false;

export const load: PageServerLoad = async () => {
	const items = PRODUCTS.slice(0, 3000);
	const dated = items.map(reviewDates);
	const dated_shared = items.map(reviewDatesShared);
	const branded = items.map((p) => brandOf(p)?.name ?? '');
	const branded_indexed = items.map((p) => brandOfIndexed(p)?.name ?? '');
	const sale = items.map(onSale);
	const sale_shallow = items.map(onSaleShallow);
	const colour = items.map((p) => specOf(p, 'spec_11'));
	const colour_direct = items.map((p) => specDirect(p, 'spec_11'));
	return {
		count: items.length,
		first: { dated: dated[0], shared: dated_shared[0], brand: branded[0], indexed: branded_indexed[0], sale: sale[0].price, shallow: sale_shallow[0].price, spec: colour[0], direct: colour_direct[0] }
	};
};
