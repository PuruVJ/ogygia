// /inferno's catalog layer with the profiler's COUNTED fixes applied (the key found by name, the
// index built in place, no deep copy). What the forecast does not count is left as it was: the
// search inside attachBrands (it runs once at startup now), the per-result regex, the memo that
// never hits. (No PATTERN comments: this copy measures the forecast.)
import * as v from 'valibot';
import { BRANDS, DICT, OFFERS, type Brand, type Product } from '../inferno/data';

export interface ProductView extends Product {
	brand?: Brand;
	offers: number;
	score: number;
}

export function attachBrands(products: Product[]): ProductView[] {
	const out: ProductView[] = [];
	for (const p of products) {
		const brand = BRANDS.find((b) => b.id === p.brandId);
		const offers = OFFERS.filter((o) => o.sku === p.id).length;
		out.push({ ...p, brand, offers, score: 0 });
	}
	return out;
}

const BRAND_BY_ID = new Map(BRANDS.map((b) => [b.id, b]));
export const brandOf = (id: number) => BRAND_BY_ID.get(id);

export function indexById(items: ProductView[]): Record<string, ProductView> {
	const acc: Record<string, ProductView> = {};
	for (const p of items) acc[p.id] = p;
	return acc;
}

const DICT_MAP = new Map(Object.entries(DICT));
export function tr(key: string): string {
	return DICT_MAP.get(key) ?? key;
}

export function forView(p: ProductView): ProductView {
	return p;
}

export function matches(p: Product, term: string): boolean {
	const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
	return re.test(p.name) || p.tags.some((t) => re.test(t));
}

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

const view_cache = new WeakMap<object, ProductView>();
export function toView(p: ProductView): ProductView {
	const hit = view_cache.get(p);
	if (hit) return hit;
	const v = { ...p, score: scoreOf(p) };
	view_cache.set(p, v);
	return v;
}
function scoreOf(p: ProductView): number {
	let s = 0;
	for (let k = 0; k < 40; k++) for (const r of p.reviews) s += (r.stars * (k + 1) + JSON.stringify(p.specs).length) % 7;
	return s / (40 * p.reviews.length);
}

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

export function totalPrice(items: { price: number }[]): number {
	let total = 0;
	for (const i of items) total += i.price;
	return total;
}

export const specList = (specs: Record<string, string>) => Object.entries(specs).map(([k, val]) => `${k}: ${val}`);

export const pages = (n: number) => Array.from({ length: Math.ceil(n / 24) }, (_, i) => i + 1);
