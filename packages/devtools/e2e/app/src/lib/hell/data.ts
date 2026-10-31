// HELL PAGE DATA — a se-web-platform-shaped commerce page, deliberately overbuilt: a mega-menu
// config the size of a small book (not in page.data — it comes from "its own server module"), a
// country selector with hundreds of links, a catalog whose every product carries a spec sheet and a
// price table, a taxonomy tree, and a few values that force the devalue lane (Dates, a Map).
// Deterministic so every render is the same bytes. See routes/hell.
const LOREM =
	'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';

export type MenuLink = { label: string; href: string; description: string; badge?: string };
export type MenuColumn = { title: string; links: MenuLink[] };
export type Menu = { title: string; href: string; columns: MenuColumn[]; promo: { title: string; body: string; image: string } };
export type HeaderConfig = {
	brand: string;
	locale: string;
	updated: Date;
	menus: Menu[];
	utility: MenuLink[];
	flags: Record<string, boolean>;
};

export function header_config(): HeaderConfig {
	const menus: Menu[] = Array.from({ length: 8 }, (_, m) => ({
		title: `Segment ${m + 1}`,
		href: `/segment/${m + 1}`,
		columns: Array.from({ length: 5 }, (_, c) => ({
			title: `Column ${m + 1}.${c + 1}`,
			links: Array.from({ length: 14 }, (_, l) => ({
				label: `Product family ${m + 1}.${c + 1}.${l + 1}`,
				href: `/products/${m + 1}/${c + 1}/${l + 1}`,
				description: `${LOREM.slice(0, 90)} (${m}.${c}.${l})`,
				...(l % 5 === 0 ? { badge: 'new' } : {})
			}))
		})),
		promo: { title: `Promo ${m + 1}`, body: LOREM.repeat(3), image: `/img/promo-${m + 1}.webp` }
	}));
	return {
		brand: 'Hell Electric',
		locale: 'en-US',
		updated: new Date('2026-09-20T00:00:00Z'),
		menus,
		utility: Array.from({ length: 12 }, (_, i) => ({ label: `Utility ${i}`, href: `/u/${i}`, description: '' })),
		flags: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`feature_${i}`, i % 3 === 0]))
	};
}

export type Country = { code: string; name: string; region: string; links: { label: string; href: string }[] };
export function countries(): Country[] {
	const regions = ['Europe', 'Americas', 'Asia Pacific', 'Middle East', 'Africa'];
	return Array.from({ length: 240 }, (_, i) => ({
		code: `C${i.toString(36).padStart(2, '0')}`.toUpperCase(),
		name: `Country ${i}`,
		region: regions[i % regions.length],
		links: Array.from({ length: 3 }, (_, k) => ({ label: `Site ${i}.${k}`, href: `/c/${i}/${k}` }))
	}));
}

export type Product = {
	id: string;
	sku: string;
	name: string;
	family: string;
	summary: string;
	description: string;
	price: number;
	currency: string;
	stock: number;
	rating: number;
	tags: string[];
	specs: { key: string; value: string; unit: string }[];
	prices: { qty: number; unit: number; total: number }[];
	docs: { title: string; href: string; bytes: number }[];
};

export function product(i: number): Product {
	return {
		id: `P${i}`,
		sku: `SKU-${1000 + i}`,
		name: `Compact circuit breaker ${i}`,
		family: `Family ${i % 7}`,
		summary: `${LOREM.slice(0, 120)} (${i})`,
		description: `${LOREM}(product ${i}) `.repeat(12),
		price: 120 + (i * 37) % 900 + 0.99,
		currency: 'EUR',
		stock: (i * 13) % 50,
		rating: 3 + ((i * 7) % 20) / 10,
		tags: ['breaker', `fam-${i % 7}`, i % 2 ? 'din' : 'panel', `p${i}`],
		specs: Array.from({ length: 36 }, (_, s) => ({
			key: `Spec ${s}`,
			value: `${((i + 1) * (s + 3)) % 997}`,
			unit: ['A', 'V', 'kA', 'mm', 'kg', '°C'][s % 6]
		})),
		prices: Array.from({ length: 12 }, (_, q) => {
			const qty = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000][q];
			const unit = (120 + (i * 37) % 900) * (1 - q * 0.03);
			return { qty, unit, total: unit * qty };
		}),
		docs: Array.from({ length: 6 }, (_, d) => ({ title: `Datasheet ${i}.${d}`, href: `/docs/${i}/${d}.pdf`, bytes: 100_000 + d * 4096 }))
	};
}

export type Taxonomy = { id: string; name: string; children?: Taxonomy[] };
export function taxonomy(depth = 0, path = 't'): Taxonomy {
	return {
		id: path,
		name: `Node ${path}`,
		...(depth < 4 ? { children: Array.from({ length: depth === 0 ? 6 : 4 }, (_, i) => taxonomy(depth + 1, `${path}.${i}`)) } : {})
	};
}

export const PRODUCTS = 48;

export function catalog() {
	return {
		title: 'Circuit breakers — every one we make',
		products: Array.from({ length: PRODUCTS }, (_, i) => product(i)),
		taxonomy: taxonomy(),
		// forces the devalue lane on the seed: a Map and a Date survive nothing else
		facets: new Map<string, string[]>([
			['family', Array.from({ length: 7 }, (_, i) => `Family ${i}`)],
			['mount', ['din', 'panel']]
		]),
		generated: new Date('2026-09-20T00:00:00Z')
	};
}

export function footer_columns() {
	return Array.from({ length: 6 }, (_, c) => ({
		title: `Footer ${c + 1}`,
		links: Array.from({ length: 30 }, (_, l) => ({ label: `Footer link ${c}.${l}`, href: `/f/${c}/${l}` }))
	}));
}
