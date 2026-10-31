// INFERNO, FIXED — /inferno with the profiler's COUNTED code fixes applied, to hold its forecast to
// account (the answer key profiles both and compares /inferno's "after every fix" with this page's
// measured render). Applied: each chain of waits started together, the same-every-request lines
// moved to the top level, the work for data nothing reads deleted (the sidebar's "freshest" list and
// the live value the page never shows), formatters built once, the key found by name, the index
// built in place, no deep copies, the card's table and sort done once. Left as they were, because
// the forecast does not count them: the answers fetched every render (caching is a freshness
// decision), the manifest read, the job queue, the regex per result, the memo that never hits.
// (No PATTERN comments: this page measures the forecast, it is not an answer key of its own.)
import { existsSync, readFileSync } from 'node:fs';
import { PRODUCTS } from '$lib/inferno/data';
import { attachBrands, forView, indexById, labelFor, matches, toView, totalPrice, validateAll, pages } from '$lib/inferno-fixed/catalog';
import { byName } from '$lib/inferno-fixed/format';
import { injectBadges, sitemapHtml } from '$lib/inferno/html';
import type { PageServerLoad } from './$types';

export const prerender = false;

// `?cache=1`: the forecast's second figure, applied too — every answer the report called "the same on
// every render" kept between renders (the test services answer the same bytes every time)
const answers = new Map<string, Promise<unknown>>();
let keep = false;
function get<T>(url: string): Promise<T> {
	if (!keep) return fetch(url).then((r) => r.json());
	let hit = answers.get(url);
	if (!hit) answers.set(url, (hit = fetch(url).then((r) => r.json())));
	return hit as Promise<T>;
}

async function svc(origin: string, name: string, ms: number): Promise<{ name: string; ms: number }> {
	return get(`${origin}/hell/api/${name}?ms=${ms}`);
}

async function stockOf(origin: string, id: string): Promise<{ id: string; stock: number }> {
	return get(`${origin}/hell/api/product/${id}?ms=5`);
}

async function currentUser(origin: string) {
	return svc(origin, 'session', 15);
}
async function localeOf(origin: string) {
	const s = await svc(origin, 'session', 15);
	return s.name === 'session' ? 'en-US' : 'de';
}

const recent = new Map<string, unknown>();
function remember(term: string, results: unknown[]) {
	recent.set(`${term}@${performance.now()}`, results);
}

const lastFew = new Map<string, unknown>();
function rememberBounded(term: string, results: unknown[]) {
	lastFew.set(`${term}@${performance.now()}`, results);
	if (lastFew.size > 4) lastFew.delete(lastFew.keys().next().value!);
}

async function drainJobs(jobs: number): Promise<number> {
	for (let i = 0; i < jobs; i++) await new Promise((r) => setImmediate(r));
	return jobs;
}

function readManifest(): number {
	const file = '../../pnpm-lock.yaml';
	return existsSync(file) ? readFileSync(file, 'utf8').length : 0;
}

// the same on every request: computed once, at startup
const valid = validateAll(PRODUCTS);
const joined = attachBrands(valid);
const sitemap = injectBadges(sitemapHtml(PRODUCTS));

export const load: PageServerLoad = async ({ url }) => {
	const origin = url.origin;
	const term = url.searchParams.get('q') ?? 'a';
	keep = url.searchParams.has('cache');

	const [user, cart, promos] = await Promise.all([svc(origin, 'user', 30), svc(origin, 'cart', 25), svc(origin, 'promos', 20)]);
	const [a, b, c, d] = await Promise.all([svc(origin, 'nav', 20), svc(origin, 'footer', 20), svc(origin, 'seo', 20), svc(origin, 'flags', 20)]);

	const [session, locale, again] = await Promise.all([currentUser(origin), localeOf(origin), currentUser(origin)]);

	const manifest = readManifest();
	const drained = await drainJobs(800);

	const step1 = await svc(origin, 'step1', 15);
	const step2 = await svc(origin, `step2-${step1.name}`, 15);
	const step3 = await svc(origin, `step3-${step2.name}`, 15);

	const hits = joined.filter((p) => matches(p, term));
	const sorted = [...hits].sort(byName);
	const index = indexById(sorted.slice(0, 700));
	const results = sorted.slice(0, 120).map((p) => toView({ ...forView(p) }));
	const labels = results.map((_, i) => labelFor(`ui.section.${i % 10}`));
	remember(term, sorted.slice(0, 600));
	rememberBounded(term, sorted.slice(0, 600));

	const stock = await Promise.all(results.slice(0, 12).map((p) => stockOf(origin, p.id)));

	return {
		term,
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
		labels: labels.slice(0, 3)
	};
};
