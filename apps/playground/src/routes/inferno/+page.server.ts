// INFERNO — a search results page with every slow habit /hell does not have, each in the shape it
// takes in real code, plus DECOYS that look suspicious and are fine. The comment on each says which
// slow pattern the profiler should name. Profile it: /__profiler → "Profile one page" → /inferno.
import { existsSync, readFileSync } from 'node:fs';
import { PRODUCTS } from '$lib/inferno/data';
import { attachBrands, forView, indexById, labelFor, matches, toView, totalPrice, validateAll, pages } from '$lib/inferno/catalog';
import { byName, newestReview } from '$lib/inferno/format';
import { injectBadges, sitemapHtml } from '$lib/inferno/html';
import type { PageServerLoad } from './$types';

export const prerender = false;

// PATTERN same-document: nothing on the page changes between requests (the live value is never shown), so the whole render could be a cached copy

// PATTERN same-answer: the test services answer the same bytes on every render (nothing is cached)
async function svc(origin: string, name: string, ms: number): Promise<{ name: string; ms: number }> {
	const res = await fetch(`${origin}/hell/api/${name}?ms=${ms}`);
	return res.json();
}

async function stockOf(origin: string, id: string): Promise<{ id: string; stock: number }> {
	const res = await fetch(`${origin}/hell/api/product/${id}?ms=5`);
	return res.json();
}

/** PATTERN repeat-request: two parts of the page each ask for the same session, and nobody shares it */
async function currentUser(origin: string) {
	return svc(origin, 'session', 15);
}
async function localeOf(origin: string) {
	const s = await svc(origin, 'session', 15);
	return s.name === 'session' ? 'en-US' : 'de';
}

/** PATTERN kept-per-render: a "results cache" keyed by the request time — it never hits and only
 *  grows. (A test page: this server leaks on purpose, a few MB per visit.) */
const recent = new Map<string, unknown>();
function remember(term: string, results: unknown[]) {
	recent.set(`${term}@${performance.now()}`, structuredClone(results));
}

/** DECOY-GROWTH: the same kind of cache WITH a size limit — it keeps the last 4 and drops the
 *  oldest, so after it fills it stops growing. One more render still leaves an entry behind (the
 *  memory card lists the line), and the growth check must mark it "stopped growing". (It does
 *  deep-copy, and saying so is right.) */
const lastFew = new Map<string, unknown>();
function rememberBounded(term: string, results: unknown[]) {
	lastFew.set(`${term}@${performance.now()}`, structuredClone(results));
	if (lastFew.size > 4) lastFew.delete(lastFew.keys().next().value!);
}

/** PATTERN yield-per-item: a job queue drained one event-loop turn per job */
async function drainJobs(jobs: number): Promise<number> {
	for (let i = 0; i < jobs; i++) await new Promise((r) => setImmediate(r));
	return jobs;
}

/** PATTERN sync-io: a big manifest read from disk on every request, blocking the server */
function readManifest(): number {
	const file = '../../pnpm-lock.yaml';
	return existsSync(file) ? readFileSync(file, 'utf8').length : 0;
}

export const load: PageServerLoad = async ({ url }) => {
	const origin = url.origin;
	const term = url.searchParams.get('q') ?? 'a';

	// PATTERN waits-in-a-row: three independent calls awaited one after another
	const user = await svc(origin, 'user', 30);
	const cart = await svc(origin, 'cart', 25);
	const promos = await svc(origin, 'promos', 20);

	// DECOY: four calls started together — already parallel, nothing to fix
	const [a, b, c, d] = await Promise.all([svc(origin, 'nav', 20), svc(origin, 'footer', 20), svc(origin, 'seo', 20), svc(origin, 'flags', 20)]);

	// DECOY: a live answer (a clock, stock ticks): different every render, so nothing to cache
	const live = await (await fetch(`${origin}/hell/api/live?ms=15`)).json();

	const session = await currentUser(origin);
	const locale = await localeOf(origin);
	const again = await currentUser(origin);

	const manifest = readManifest();
	const drained = await drainJobs(800);

	// DECOY: three calls in a row that must stay in a row — each asks with the answer before it
	const step1 = await svc(origin, 'step1', 15);
	const step2 = await svc(origin, `step2-${step1.name}`, 15);
	const step3 = await svc(origin, `step3-${step2.name}`, 15);

	// the search pipeline
	// PATTERN same-every-request: validated and joined from the same PRODUCTS on every request (belongs at module level)
	const valid = validateAll(PRODUCTS);
	const joined = attachBrands(valid);
	const hits = joined.filter((p) => matches(p, term));
	const sorted = [...hits].sort(byName);
	// "freshest first" for the sidebar: every product's review dates parsed again, inside a sort
	const freshest = [...valid].sort((a, b) => newestReview(b.reviews) - newestReview(a.reviews)).slice(0, 5);
	const index = indexById(sorted.slice(0, 700));
	// PATTERN render-per-item: 120 results, so 120 ResultCards rendered on every request (one page of them would do)
	const results = sorted.slice(0, 120).map((p) => toView({ ...forView(p) }));
	const labels = results.map((_, i) => labelFor(`ui.section.${i % 10}`));
	remember(term, sorted.slice(0, 600));
	rememberBounded(term, sorted.slice(0, 600));

	// PATTERN waits-in-a-row (in a loop, through a helper): live stock for the first 12, one by one
	const stock: { id: string; stock: number }[] = [];
	for (const p of results.slice(0, 12)) stock.push(await stockOf(origin, p.id));

	const sitemap = injectBadges(sitemapHtml(PRODUCTS));

	return {
		term,
		live_at: live.at as number,
		results,
		stock,
		count: hits.length,
		indexed: Object.keys(index).length,
		total: totalPrice(results),
		pages: pages(hits.length),
		sitemap,
		services: [user, cart, promos, a, b, c, d, session, again, step3].map((s) => s.name),
		locale,
		manifest,
		drained,
		freshest: freshest.map((p) => p.id),
		labels: labels.slice(0, 3)
	};
};
