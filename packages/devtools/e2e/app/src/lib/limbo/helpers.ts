// LIMBO's helpers: the profiler's rules met in shapes no other answer-key page writes them in — the
// way an app written without the profiler in mind spells them. The comment on each says which slow
// pattern the profiler should name (or, for a DECOY, why it should stay quiet).
import { BRANDS, type Brand, type Product } from '../inferno/data';

/** PATTERN formatter-per-call: each review's date formatted with a locale method and options, which builds a formatter inside on every call */
export function reviewDates(p: Product): string[] {
	return p.reviews.map((r) => new Date(r.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
}

/** DECOY: one formatter for the module, built once, used per review */
const shortDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export function reviewDatesShared(p: Product): string[] {
	return p.reviews.map((r) => shortDate.format(new Date(r.at)));
}

/** PATTERN lookup-in-loop: the product's brand found by filtering every brand, then taking the first */
export function brandOf(p: Product): Brand | undefined {
	return BRANDS.filter((b) => b.id === p.brandId)[0];
}

/** DECOY: the brands indexed once by id, each product's brand read from the index */
const brand_by_id = new Map(BRANDS.map((b) => [b.id, b]));
export function brandOfIndexed(p: Product): Brand | undefined {
	return brand_by_id.get(p.brandId);
}

/** PATTERN deep-copy: every product cloned whole (its reviews and specs too) to change one field */
export function onSale(p: Product): Product {
	const copy = structuredClone(p);
	copy.price = Math.round(p.price * 85) / 100;
	return copy;
}

/** DECOY: a shallow copy with the one field changed: no walk through reviews and specs */
export function onSaleShallow(p: Product): Product {
	return { ...p, price: Math.round(p.price * 85) / 100 };
}

/** PATTERN scan-for-key: a spec found by walking every entry of the table for the one key */
export function specOf(p: Product, key: string): string | undefined {
	for (const [k, v] of Object.entries(p.specs)) if (k === key) return v;
	return undefined;
}

/** DECOY: the spec read by its key */
export function specDirect(p: Product, key: string): string | undefined {
	return Object.hasOwn(p.specs, key) ? p.specs[key] : undefined;
}
