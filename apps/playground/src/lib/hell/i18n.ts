// A cross-cutting i18n helper the way one grows in a big site: a flat catalog scanned per call,
// pluralisation by regex, interpolation by regex, a fallback chain of locales. Called from every
// component on the page, hundreds of times per render, from many different places.
const CATALOG: Record<string, Record<string, string>> = {
	'en-US': {
		'product.in_stock': '{n} in stock',
		'product.in_stock.one': '{n} item in stock',
		'product.in_stock.other': '{n} items in stock',
		'product.docs': 'Documents',
		'product.add': 'Add to cart ({n})',
		'spec.label': '{label}',
		'facet.count': '{n} results',
		'menu.promo': 'Promotion: {title}',
		'country.sites': '{n} sites',
		'footer.links': '{n} links',
		'crumb.home': 'Home',
		'crumb.catalog': 'Catalog',
		'price.from': 'from {price}',
		'rating.stars': '{n} out of 5'
	},
	en: {
		'product.summary': 'Summary'
	}
};

function lookup(key: string, locale: string): string | undefined {
	// the fallback chain, rebuilt per call: en-US → en → the first locale with the key
	const chain = [locale, locale.split('-')[0], ...Object.keys(CATALOG)];
	for (const l of chain) {
		const table = CATALOG[l];
		if (!table) continue;
		for (const [k, v] of Object.entries(table)) if (k === key) return v;
	}
	return undefined;
}

function plural(key: string, n: number | undefined, locale: string): string | undefined {
	if (n === undefined) return lookup(key, locale);
	const rules = new Intl.PluralRules(locale);
	return lookup(`${key}.${rules.select(n)}`, locale) ?? lookup(key, locale);
}

export function t(key: string, vars: Record<string, string | number> = {}, locale = 'en-US'): string {
	const n = typeof vars.n === 'number' ? vars.n : undefined;
	const template = plural(key, n, locale) ?? key;
	return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}
