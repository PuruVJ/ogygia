// The catalog layer: joins, lookups and copies, each in the shape it usually has. The comment on
// each says which slow pattern the profiler should name (or, for a DECOY, why it should not).
import * as v from 'valibot';
import { BRANDS, DICT, OFFERS, type Brand, type Product } from './data';

export interface ProductView extends Product {
	brand?: Brand;
	offers: number;
	score: number;
}

/** PATTERN lookup-in-loop: each product's brand and offers found by scanning whole lists */
export function attachBrands(products: Product[]): ProductView[] {
	const out: ProductView[] = [];
	for (const p of products) {
		const brand = BRANDS.find((b) => b.id === p.brandId);
		const offers = OFFERS.filter((o) => o.sku === p.id).length;
		out.push({ ...p, brand, offers, score: 0 });
	}
	return out;
}

/** DECOY: the same join through a Map built once — the right way, and cheap */
const BRAND_BY_ID = new Map(BRANDS.map((b) => [b.id, b]));
export const brandOf = (id: number) => BRAND_BY_ID.get(id);

/** PATTERN spread-accumulate: an index built by copying the object at every step */
export function indexById(items: ProductView[]): Record<string, ProductView> {
	return items.reduce((acc, p) => ({ ...acc, [p.id]: p }), {} as Record<string, ProductView>);
}

/** PATTERN scan-for-key: one UI string found by walking all 2 000 of them */
export function tr(key: string): string {
	for (const [k, text] of Object.entries(DICT)) if (k === key) return text;
	return key;
}

/** PATTERN deep-copy: "don't let the view touch the model" */
export function forView(p: ProductView): ProductView {
	return JSON.parse(JSON.stringify(p));
}

/** PATTERN regexp-per-call: the search term compiled again for every result */
export function matches(p: Product, term: string): boolean {
	const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
	return re.test(p.name) || p.tags.some((t) => re.test(t));
}

/** PATTERN library-per-item: every product validated one at a time with a schema library */
const ProductSchema = v.object({
	id: v.string(),
	name: v.pipe(v.string(), v.minLength(1)),
	price: v.pipe(v.number(), v.minValue(0)),
	currency: v.picklist(['EUR', 'USD', 'SEK', 'JPY']),
	tags: v.array(v.string()),
	updated: v.pipe(v.string(), v.isoTimestamp()),
	reviews: v.array(v.object({ stars: v.number(), at: v.pipe(v.string(), v.isoTimestamp()), body: v.string() })),
	specs: v.record(v.string(), v.string())
});
export function validateAll(products: Product[]): Product[] {
	const ok: Product[] = [];
	for (const p of products) if (v.safeParse(ProductSchema, p).success) ok.push(p);
	return ok;
}

/** PATTERN cache-never-hits: a view memo keyed by the object — and the page hands it a fresh copy
 *  every time, so every call misses, does the work, and stores it for nobody */
const view_cache = new WeakMap<object, ProductView>();
export function toView(p: ProductView): ProductView {
	const hit = view_cache.get(p);
	if (hit) return hit;
	const v = { ...p, score: scoreOf(p) };
	view_cache.set(p, v);
	return v;
}
/** the work the memo was meant to save: a score over every review and spec */
function scoreOf(p: ProductView): number {
	let s = 0;
	for (let k = 0; k < 40; k++) for (const r of p.reviews) s += (r.stars * (k + 1) + JSON.stringify(p.specs).length) % 7;
	return s / (40 * p.reviews.length);
}

/** DECOY: a memo keyed by a stable string, asked for ten keys over and over — it hits */
const label_cache = new Map<string, string>();
export function labelFor(key: string): string {
	const hit = label_cache.get(key);
	if (hit !== undefined) return hit;
	const text = humanLabel(key);
	label_cache.set(key, text);
	return text;
}
function humanLabel(key: string): string {
	let out = '';
	for (let k = 0; k < 200; k++) out = key.toUpperCase().split('.').join(' / ');
	return out;
}

/** DECOY: summing numbers in a loop is not string growth */
export function totalPrice(items: { price: number }[]): number {
	let total = 0;
	for (const i of items) total += i.price;
	return total;
}

/** DECOY: walking all entries to build a list is fine — it needs every entry */
export const specList = (specs: Record<string, string>) => Object.entries(specs).map(([k, val]) => `${k}: ${val}`);

/** DECOY: a table sized by the input is real work, not a fixed table */
export const pages = (n: number) => Array.from({ length: Math.ceil(n / 24) }, (_, i) => i + 1);
