// HELL, FIXED — /hell with the profiler's COUNTED code fixes applied, to hold its forecast to account
// (the answer key profiles both and compares /hell's "after every fix" with this page's render).
// Applied here: pricing and inventory started together, the stock calls started together, the
// queue yielding every few hundred turns instead of every one. In lib/hell-fixed: formatters built
// once, the key found by name, no deep copy, the icon table built once, the markdown walked once. In
// the design-system pass (lib/hell/ds-ssr.ts, its fast path for this route): each distinct tag
// rendered once, the document walked once. Left as they were, because the forecast does not count
// them: the answers fetched every render, the layout's calls, the database wait, the file read,
// the cache that never hits. (No PATTERN comments: this page measures the forecast.)
import { readFile } from 'node:fs/promises';
import type { PageServerLoad } from './$types';
import { span, tag } from 'ogygia/profiler';
import { catalog, PRODUCTS } from '$lib/hell-fixed/data';

async function queryDatabase(ms: number): Promise<{ rows: number }> {
	await new Promise((r) => setTimeout(r, ms));
	return { rows: ms * 3 };
}

async function callService(origin: string, name: string, ms: number): Promise<{ name: string; ms: number }> {
	const res = await fetch(`${origin}/hell/api/${name}?ms=${ms}`);
	return res.json();
}

async function fetchStock(origin: string, id: string): Promise<{ id: string; stock: number }> {
	const res = await fetch(`${origin}/hell/api/product/${id}?ms=6`);
	return res.json();
}

async function drainQueue(turns: number): Promise<number> {
	for (let i = 0; i < turns; i++) if (i % 300 === 299) await new Promise((r) => setImmediate(r));
	return turns;
}

const cache = new Map<string, unknown>();

export const prerender = false;

export const load: PageServerLoad = async ({ url, params, parent }) => {
	const origin = url.origin;
	tag('tenant', 'acme');
	tag('locale', (params as { lang?: string }).lang ?? 'en-US');
	const { session } = await parent();
	const [pricing, inventory] = await Promise.all([
		span('svc.pricing', () => callService(origin, 'pricing', 40)),
		span('svc.inventory', () => callService(origin, 'inventory', 35))
	]);
	const db = await span('db.rows', () => queryDatabase(60), (r) => ({ rows: r.rows }));
	const manifest = (await span('cms.manifest', () => readFile('package.json', 'utf8'))).length;
	const drained = await span('queue.drain', () => drainQueue(1500));
	const segments = await span(
		'cache.segments',
		async () => {
			const hit = cache.get('segments');
			if (hit) return { value: hit as string[], fromCache: true };
			await new Promise((r) => setTimeout(r, 18));
			const value = ['pro', 'residential', 'partner'];
			cache.set('segments', value);
			cache.delete('segments');
			return { value, fromCache: false };
		},
		(r) => ({ cache: r.fromCache ? 'hit' : 'miss' })
	);
	const [promos, banners, footer] = await Promise.all([
		callService(origin, 'promos', 30),
		callService(origin, 'banners', 28),
		callService(origin, 'footer', 25)
	]);
	const stock: Record<string, number> = {};
	const ids = Array.from({ length: Math.min(PRODUCTS, 16) }, (_, i) => `P${i}`);
	for (const s of await Promise.all(ids.map((id) => span('stock.lookup', () => fetchStock(origin, id), { key: id })))) stock[s.id] = s.stock;
	return {
		catalog: span('cms.catalog', () => catalog(), (c) => ({ rows: c.products.length })),
		stock,
		session,
		pricing,
		inventory,
		db,
		manifest,
		drained,
		segments: segments.value,
		promos,
		banners,
		footer,
		greeting: 'hello from hell'
	};
};
