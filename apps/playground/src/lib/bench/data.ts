// SERVER-COST BENCH DATA (routes/bench-cms): a large CMS page shape, deterministic so every request
// renders the same bytes. Twenty block islands fed slices of a ~700 KB page.data tree (the seed), plus
// a header island fed a ~300 KB config that is NOT in page.data (the real header's shape), plus one
// `$page` reader so the seed ships. Tune BLOCKS / MENU_* to scale.
const LOREM =
	'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';

export type Block = {
	id: string;
	kind: 'hero' | 'card' | 'text';
	title: string;
	body: string;
	tags: string[];
	meta: { author: string; updated: string; weight: number; links: { href: string; label: string }[] };
	rows: { sku: string; price: number; stock: number; desc: string }[];
};

export const BLOCKS = 20;

export function block(i: number): Block {
	return {
		id: `block-${i}`,
		kind: i === 0 ? 'hero' : i % 2 ? 'card' : 'text',
		title: `Block ${i}: ${LOREM.slice(0, 40)}`,
		// unique per block: devalue dedupes repeated strings, which would shrink the seed unrealistically
		body: `${LOREM}(block ${i}) `.repeat(40),
		tags: ['one', 'two', `tag-${i}`],
		meta: {
			author: 'cms',
			updated: '2026-09-10',
			weight: i,
			links: Array.from({ length: 8 }, (_, k) => ({ href: `/link/${i}/${k}`, label: `Link ${i} ${k}` }))
		},
		rows: Array.from({ length: 60 }, (_, r) => ({
			sku: `SKU-${i}-${r}`,
			price: (i * 100 + r * 7) / 3,
			stock: (i + r) % 17,
			desc: `${LOREM.slice(0, 80)} row ${i}.${r}`
		}))
	};
}

export function page_tree() {
	const blocks = Array.from({ length: BLOCKS }, (_, i) => block(i));
	return { catalog: { title: 'Bench catalog', blocks }, greeting: 'hello from page.data' };
}

// Header config: NOT part of page.data (mirrors the real header, whose props come from its own
// server module), so it crosses as a full props payload, not a seed reference.
export type MenuItem = { label: string; href: string; description: string; children: { label: string; href: string }[] };
export type HeaderConfig = { locale: string; menus: { title: string; items: MenuItem[] }[]; countries: { code: string; name: string; href: string }[] };

const MENU_COUNT = 6;
const MENU_ITEMS = 40;

export const header_config: HeaderConfig = {
	locale: 'fr-FR',
	menus: Array.from({ length: MENU_COUNT }, (_, m) => ({
		title: `Menu ${m}`,
		items: Array.from({ length: MENU_ITEMS }, (_, i) => ({
			label: `Item ${m}.${i}`,
			href: `/menu/${m}/item/${i}`,
			description: `${LOREM.slice(0, 100)} (${m}.${i})`,
			children: Array.from({ length: 6 }, (_, c) => ({ label: `Child ${m}.${i}.${c}`, href: `/menu/${m}/item/${i}/child/${c}` }))
		}))
	})),
	countries: Array.from({ length: 120 }, (_, c) => ({ code: `C${c}`, name: `Country ${c}`, href: `/country/${c}` }))
};
