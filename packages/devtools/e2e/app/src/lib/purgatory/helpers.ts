// PURGATORY's helpers: the shapes the profiler's newest rules must tell apart. The comment on each
// says which slow pattern the profiler should name (or, for a DECOY, why it should stay quiet).
import { PRODUCTS, type Product } from '../inferno/data';

/** PATTERN formatter-per-call: a new NumberFormat for every price */
export function priceOf(n: number, currency: string): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
}

/** DECOY: the cached factory the profiler's own written change has: built once per currency, used per price */
const money = new Map<string, Intl.NumberFormat>();
export function priceCached(n: number, currency: string): string {
	let f = money.get(currency);
	if (!f) money.set(currency, (f = new Intl.NumberFormat('en-US', { style: 'currency', currency })));
	return f.format(n);
}

/** PATTERN spread-accumulate: the tag list grown by copying everything built so far at every step */
export function allTags(items: Product[]): string[] {
	let acc: string[] = [];
	for (const p of items) acc = [...acc, ...p.tags];
	return acc;
}

/** DECOY: each item spread into a new object: one item copied per step, not the whole list */
export function withDiscount(items: Product[]): (Product & { sale: number })[] {
	return items.map((p) => ({ ...p, sale: Math.round(p.price * 80) / 100 }));
}

/** DECOY: a chunk's items pushed with a spread: the call's arguments, not a copy of the accumulator */
export function flatten(chunks: string[][]): string[] {
	const out: string[] = [];
	for (const c of chunks) out.push(...c);
	return out;
}

/** a slug check on a brand's name (letters, digits, single dashes) */
export function isSlug(s: string): boolean {
	// PATTERN slow-regex: every brand name ends in "Co.", so the check fails at the very end, after trying every way to split the letters before it
	return /^([a-z0-9]+-?)*$/.test(s);
}

/** the same check, rewritten so each character matches one way (for /purgatory-fixed) */
export function isSlugSafe(s: string): boolean {
	return /^[a-z0-9]+(?:-[a-z0-9]+)*-?$/.test(s);
}

/** DECOY: a quick pattern, run once per product: cheap each time, nothing in it to rewrite */
export function initials(name: string): string {
	return name.replace(/\b(\w)\w*/g, '$1');
}

/** the module's own rows (a load below shadows the name with the request's rows) */
export const catalogRows: Product[] = PRODUCTS.slice(0, 50);

export function sortByName(rows: Product[]): Product[] {
	return [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
