// The per-row helpers a real design-system page ends up calling thousands of times per render —
// each written the WAY IT USUALLY IS (allocated per call, regex per call), so the profiler has
// something honest to blame.

/** A PascalCase class in app code, constructed during SSR: the profiler must NOT call it a component. */
export class IntersectionObserverPolyfill {
	readonly targets: string[] = [];
	constructor(readonly root: string) {}
	observe(id: string): void {
		this.targets.push(id);
	}
	summary(): string {
		return `${this.root}:${this.targets.length}`;
	}
}

/** Another PascalCase helper — a slug builder that keeps a cache it never hits (new instance per call site). */
export class Slugger {
	#seen = new Map<string, number>();
	slug(text: string): string {
		const base = text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
		const n = this.#seen.get(base) ?? 0;
		this.#seen.set(base, n + 1);
		return n ? `${base}-${n}` : base;
	}
}

/** The classic per-row cost: an `Intl.NumberFormat` built for every price. */
export function formatPrice(n: number, currency: string, locale = 'en-US'): string {
	return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n);
}

/** A regex-heavy "markdownish" transform of a description, per product. */
export function tokenize(text: string): string {
	return text
		.replace(/\b([A-Z][a-z]+)\b/g, '<em>$1</em>')
		.replace(/(\d+)/g, '<b>$1</b>')
		.replace(/\s{2,}/g, ' ')
		.split('. ')
		.map((s) => `<span>${s}</span>`)
		.join(' ');
}

/** Structured-data JSON per product, like the SEO blocks a CMS page emits per card. */
export function jsonLd(p: { id: string; name: string; price: number; currency: string; specs: unknown[] }): string {
	return JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'Product',
		productID: p.id,
		name: p.name,
		offers: { '@type': 'Offer', price: p.price, priceCurrency: p.currency },
		additionalProperty: p.specs
	});
}

/** A recursive tree walk that copies as it goes (the "clone the CMS node" habit). */
export function walkTree<T extends { children?: T[] }>(node: T, depth = 0): { count: number; depth: number } {
	let count = 1;
	let max = depth;
	for (const c of node.children ?? []) {
		const r = walkTree({ ...c }, depth + 1);
		count += r.count;
		if (r.depth > max) max = r.depth;
	}
	return { count, depth: max };
}
