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

// ── THE CHAINS ─────────────────────────────────────────────────────────────────────────────
// Real pages do not have one slow function; they have a dozen warm ones that sit on a few call
// paths. Each chain below is written the way it usually is: a top-level helper that fans out
// into two or three smaller ones, each allocating or regexing per call. The profiler's "paths to
// fix" should find the top of each chain, not the leaves.

// chain 1 — the spec sheet: renderSpecs → specLabel → humanize, renderSpecs → formatUnit → roundTo + unitName
export function renderSpecs(specs: { key: string; value: string; unit: string }[]): { label: string; text: string }[] {
	return specs.map((s) => ({ label: specLabel(s.key), text: formatUnit(Number(s.value), s.unit) }));
}
export function specLabel(key: string): string {
	return humanize(key.replace(/_/g, ' ')) + ':';
}
export function humanize(s: string): string {
	return s
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/\s+/g, ' ')
		.split(' ')
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
		.join(' ');
}
export function formatUnit(value: number, unit: string): string {
	return `${roundTo(value * 1.000001, 2)} ${unitName(unit)}`;
}
export function roundTo(n: number, digits: number): string {
	const f = 10 ** digits;
	return (Math.round(n * f) / f).toFixed(digits).replace(/\.?0+$/, '');
}
export function unitName(unit: string): string {
	// a lookup table rebuilt per call (the "const inside the function" habit)
	const names: Record<string, string> = { A: 'ampere', V: 'volt', kA: 'kiloampere', mm: 'millimetre', kg: 'kilogram', '°C': 'degree Celsius' };
	return names[unit] ?? unit;
}

// chain 2 — the price table: priceTable → formatPrice + currencySymbol (an Intl.NumberFormat per call, twice)
export function priceTable(prices: { qty: number; unit: number; total: number }[], currency: string): { qty: number; unit: string; total: string; sym: string }[] {
	return prices.map((p) => ({ qty: p.qty, unit: formatPrice(p.unit, currency), total: formatPrice(p.total, currency), sym: currencySymbol(currency) }));
}
export function currencySymbol(currency: string, locale = 'en-US'): string {
	return new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency;
}

// chain 3 — the header: buildMenus → localizeLink → interpolate → escapeText
export function buildMenus<M extends { title: string; columns: { title: string; links: { label: string; description: string }[] }[] }>(
	menus: M[],
	locale: string,
	slug: (s: string) => string
) {
	return menus.map((m) => ({
		...m,
		slug: slug(m.title),
		columns: m.columns.map((c) => ({ ...c, links: c.links.map((l) => ({ ...l, slug: slug(l.label), text: localizeLink(l, locale) })) }))
	}));
}
export function localizeLink(link: { label: string; description: string }, locale: string): string {
	return interpolate('{label} — {description} ({locale})', { label: link.label, description: link.description, locale });
}
export function interpolate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (_, k: string) => escapeText(vars[k] ?? ''));
}
export function escapeText(s: string): string {
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		out += ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch === '"' ? '&quot;' : ch;
	}
	return out;
}

// chain 4 — the facet bar: computeFacets → groupBy → facetKey → normalizeKey
export function computeFacets<P extends { family: string; tags: string[]; currency: string }>(products: P[]): { dim: string; values: { key: string; count: number }[] }[] {
	return ['family', 'mount', 'currency', 'tag'].map((dim) => {
		const groups = groupBy(products, (p) => facetKey(p, dim));
		return { dim, values: [...groups].map(([key, list]) => ({ key, count: list.length })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)) };
	});
}
export function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const it of items) {
		const k = key(it);
		const list = out.get(k) ?? [];
		list.push(it);
		out.set(k, [...list]); // copies the bucket on every insert
	}
	return out;
}
export function facetKey(p: { family: string; tags: string[]; currency: string }, dim: string): string {
	switch (dim) {
		case 'family':
			return normalizeKey(p.family);
		case 'mount':
			return normalizeKey(p.tags.find((t) => t === 'din' || t === 'panel') ?? 'other');
		case 'currency':
			return normalizeKey(p.currency);
		default:
			return normalizeKey(p.tags.join(' '));
	}
}
export function normalizeKey(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

// chain 5 — related products: rankProducts → score → similarity (an O(n·m) edit distance per pair) + tokens
export function rankProducts<P extends { name: string; tags: string[]; family: string }>(products: P[], query: string, top = 8): { product: P; score: number }[] {
	return products
		.map((product) => ({ product, score: score(product, query) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, top);
}
export function score(p: { name: string; tags: string[]; family: string }, query: string): number {
	const q = tokens(query);
	let best = 0;
	for (const t of tokens(`${p.name} ${p.family} ${p.tags.join(' ')}`)) {
		for (const w of q) best = Math.max(best, 1 - similarity(t, w) / Math.max(t.length, w.length, 1));
	}
	return best;
}
export function tokens(s: string): string[] {
	return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
/** Levenshtein, the textbook way (a fresh matrix per pair). */
export function similarity(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array<number>(n).fill(0)]);
	for (let j = 1; j <= n; j++) d[0][j] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
	}
	return d[m][n];
}

// chain 6 — the country list: sortCountries → collate (an Intl.Collator per comparison) → stripDiacritics
export function sortCountries<C extends { name: string; region: string }>(list: C[]): C[] {
	return [...list].sort((a, b) => collate(a.region, b.region) || collate(a.name, b.name));
}
export function collate(a: string, b: string): number {
	return new Intl.Collator('en', { sensitivity: 'base' }).compare(stripDiacritics(a), stripDiacritics(b));
}
export function stripDiacritics(s: string): string {
	return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
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
