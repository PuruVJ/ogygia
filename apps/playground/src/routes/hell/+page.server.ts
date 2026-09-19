// HELL — a se-web-platform-shaped page's load, written the way such loads end up: three services
// awaited one after another, a "database" wait, a file read, one Promise.all that is fine, and an
// N+1 loop fetching one product endpoint per card. Point the profiler at /hell.
//
// Instrumented with `span` / `tag` from ogygia/profiler — the waits the sampler cannot see
// (the database pool, a cache lookup, a queue drain) get names, the request gets a tenant.
import { readFile } from 'node:fs/promises';
import type { PageServerLoad } from './$types';
import { span, tag } from 'ogygia/profiler';
import { catalog, PRODUCTS } from '$lib/hell/data';

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

// A wait NO hook can see: a queue drained over event-loop turns (setImmediate is not an I/O
// primitive), the shape of a promise chain inside a driver — without a span it is "nothing recorded".
async function drainQueue(turns: number): Promise<number> {
	for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
	return turns;
}

// A per-instance cache that is cold on every render — a miss each time, and the span says so.
const cache = new Map<string, unknown>();

export const prerender = false;

export const load: PageServerLoad = async ({ url, params }) => {
	const origin = url.origin;
	tag('tenant', 'acme');
	tag('locale', (params as { lang?: string }).lang ?? 'en-US');
	// sequential — each waits for the previous although none needs it
	const session = await span('svc.session', () => callService(origin, 'session', 45));
	const pricing = await span('svc.pricing', () => callService(origin, 'pricing', 40));
	const inventory = await span('svc.inventory', () => callService(origin, 'inventory', 35));
	// a database round trip on its own socket (a timer here)
	const db = await span('db.rows', () => queryDatabase(60), (r) => ({ rows: r.rows }));
	// a file read (a CMS manifest)
	const manifest = (await span('cms.manifest', () => readFile('package.json', 'utf8'))).length;
	// the queue the hooks cannot see
	const drained = await span('queue.drain', () => drainQueue(1500));
	// the cache that never hits
	const segments = await span(
		'cache.segments',
		async () => {
			const hit = cache.get('segments');
			if (hit) return { value: hit as string[], fromCache: true };
			await new Promise((r) => setTimeout(r, 18));
			const value = ['pro', 'residential', 'partner'];
			cache.set('segments', value);
			cache.delete('segments'); // per-request instance in disguise
			return { value, fromCache: false };
		},
		(r) => ({ cache: r.fromCache ? 'hit' : 'miss' })
	);
	// the one that is done right
	const [promos, banners, footer] = await Promise.all([
		callService(origin, 'promos', 30),
		callService(origin, 'banners', 28),
		callService(origin, 'footer', 25)
	]);
	// N+1: live stock, one call per card — each call its own span, keyed
	const stock: Record<string, number> = {};
	for (let i = 0; i < Math.min(PRODUCTS, 16); i++) {
		const id = `P${i}`;
		const s = await span('stock.lookup', () => fetchStock(origin, id), { key: id });
		stock[s.id] = s.stock;
	}
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
