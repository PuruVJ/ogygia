// INFERNO DEALS — a second page on the same site that calls /inferno's shared helpers: the price and
// date formatters, the name sort, the UI-string lookup. Each slow helper line then slows two pages,
// and the dashboard's "fix once, faster on every page" adds them up. (Not an answer-key page: no
// PATTERN comments; /inferno's own comments name what the helpers do wrong.)
import { PRODUCTS } from '$lib/inferno/data';
import { tr } from '$lib/inferno/catalog';
import { byName, formatMoney, relTime } from '$lib/inferno/format';
import type { PageServerLoad } from './$types';

export const prerender = false;

export const load: PageServerLoad = async () => {
	const deals = [...PRODUCTS.slice(0, 400)].sort(byName).slice(0, 200);
	return {
		title: tr('ui.key.7'),
		deals: deals.map((p, i) => ({
			id: p.id,
			name: p.name,
			price: formatMoney(p.price * 0.8, p.currency),
			was: formatMoney(p.price, p.currency),
			updated: relTime(p.updated),
			badge: tr(`ui.key.${i * 3}`)
		}))
	};
};
