// DTO → view-model mappers, the way a CMS-backed page ends up with them: a deep clone of the input
// first ("never mutate the CMS node"), a mapper per nested shape, a memo keyed by identity that
// never hits because the page hands it fresh copies every render.
import type { Product } from './data';
import { renderSpecs, priceTable, tokenize } from './util';
import { renderMarkdown } from './markdown';

export interface ProductVM {
	id: string;
	sku: string;
	title: string;
	summaryHtml: string;
	descriptionHtml: string;
	price: number;
	currency: string;
	stock: number;
	rating: number;
	tags: string[];
	specs: { label: string; text: string }[];
	prices: { qty: number; unit: string; total: string; sym: string }[];
	docs: { title: string; href: string; kb: number; icon: string }[];
}

const memo = new WeakMap<Product, ProductVM>();

export function toProductVM(input: Product): ProductVM {
	const hit = memo.get(input);
	if (hit) return hit;
	const p = structuredClone(input); // "defensive"
	const vm: ProductVM = {
		id: p.id,
		sku: p.sku,
		title: `${p.name} (${p.sku})`,
		summaryHtml: tokenize(p.summary),
		descriptionHtml: renderMarkdown(p.description),
		price: p.price,
		currency: p.currency,
		stock: p.stock,
		rating: p.rating,
		tags: p.tags.map((t) => t.trim().toLowerCase()),
		specs: renderSpecs(p.specs),
		prices: priceTable(p.prices, p.currency),
		docs: p.docs.map(toDocVM)
	};
	memo.set(input, vm);
	return vm;
}

export function toDocVM(d: { title: string; href: string; bytes: number }): ProductVM['docs'][number] {
	return { title: d.title, href: d.href, kb: Math.round(d.bytes / 1024), icon: d.href.endsWith('.pdf') ? 'pdf' : 'file' };
}
