// INFERNO's data: a search index the size a real shop has. Built ONCE per server start
// (module scope, deterministic), so every render works on the same numbers and a profile of one
// render is comparable with the next.

export interface Brand {
	id: number;
	name: string;
	country: string;
}

export interface Review {
	stars: number;
	/** ISO text, the way an API sends it */
	at: string;
	body: string;
}

export interface Product {
	id: string;
	name: string;
	brandId: number;
	price: number;
	currency: string;
	tags: string[];
	/** ISO text */
	updated: string;
	reviews: Review[];
	specs: Record<string, string>;
}

let seed = 42;
const rand = () => {
	seed = (seed * 1664525 + 1013904223) % 4294967296;
	return seed / 4294967296;
};
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];

const WORDS = ['alpine', 'breeze', 'cobalt', 'delta', 'ember', 'fjord', 'granite', 'harbor', 'iris', 'juniper', 'kestrel', 'lumen', 'meadow', 'nimbus', 'onyx', 'prairie', 'quartz', 'ridge', 'sierra', 'tundra'];
const KINDS = ['jacket', 'boot', 'tent', 'pack', 'stove', 'lamp', 'glove', 'bottle', 'rope', 'map'];
const COUNTRIES = ['DE', 'FR', 'IT', 'ES', 'SE', 'NO', 'US', 'CA', 'JP', 'NZ'];

export const BRANDS: Brand[] = Array.from({ length: 400 }, (_, i) => ({
	id: i,
	name: `${pick(WORDS)} ${pick(WORDS)} Co.`.replace(/^./, (c) => c.toUpperCase()),
	country: pick(COUNTRIES)
}));

const day = 86_400_000;
const t0 = Date.UTC(2025, 0, 1);

export const PRODUCTS: Product[] = Array.from({ length: 3000 }, (_, i) => ({
	id: `SKU-${String(i).padStart(5, '0')}`,
	name: `${pick(WORDS)} ${pick(KINDS)} ${i % 97}`,
	brandId: Math.floor(rand() * 400),
	price: Math.round(rand() * 50000) / 100,
	currency: pick(['EUR', 'USD', 'SEK', 'JPY']),
	tags: Array.from({ length: 4 }, () => pick(WORDS)),
	updated: new Date(t0 + Math.floor(rand() * 400) * day).toISOString(),
	reviews: Array.from({ length: 6 }, () => ({
		stars: 1 + Math.floor(rand() * 5),
		at: new Date(t0 + Math.floor(rand() * 400) * day).toISOString(),
		body: `${pick(WORDS)} ${pick(WORDS)} ${pick(KINDS)}, would ${pick(['buy', 'skip', 'recommend'])} again`
	})),
	specs: Object.fromEntries(Array.from({ length: 12 }, (_, k) => [`spec_${k}`, `${pick(WORDS)}-${k}`]))
}));

/** seller offers, one list for the whole catalog (the way a pricing feed arrives) */
export const OFFERS = Array.from({ length: 3000 }, (_, i) => ({ sku: `SKU-${String((i * 7) % 3000).padStart(5, '0')}`, seller: pick(WORDS), price: Math.round(rand() * 50000) / 100 }));

/** the UI strings: 2 000 keys, the way a translation export looks */
export const DICT: Record<string, string> = Object.fromEntries(
	Array.from({ length: 2000 }, (_, i) => [`ui.key.${i}`, `${pick(WORDS)} ${pick(WORDS)}`])
);

/** badge tokens the CMS template carries, replaced in the finished HTML */
export const BADGES = Array.from({ length: 40 }, (_, i) => ({ token: `%%BADGE_${i}%%`, html: `<span class="badge b${i}">${pick(WORDS)}</span>` }));
