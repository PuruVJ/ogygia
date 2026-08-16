// single-flight navigation (Playwright). Usage: node verify/frame-nav-batch.ts [baseUrl]
//
// Navigating (SPA) to a page with several load-timed server islands must pull them all in ONE batch
// stream — the router prescans the incoming holes and streams them together. Proof: on the navigation
// there is exactly ONE POST to the island endpoint (the batch) and ZERO per-region GETs (no waterfall),
// yet every island fills. This is the fourth frames facet: navigation is a batch of frame writes.
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out: string[] = [];
const check = (name: string, cond: boolean, extra = '') => {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

// Any request to the island endpoint (🏝️, raw or percent-encoded).
const ISLAND = /(?:%F0%9F%8F%9D|🏝)/;

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	let batchPosts = 0;
	let regionGets = 0;
	page.on('request', (req) => {
		if (!ISLAND.test(req.url())) return;
		if (req.method() === 'POST') batchPosts++;
		else if (req.method() === 'GET') regionGets++;
	});

	// Start on a plain SPA page so the router is live, then navigate to /nav-batch by clicking its link.
	await page.goto(base + '/data', { waitUntil: 'load' });
	await page.waitForSelector('meta[name="ogygia-router"]', { state: 'attached', timeout: 8000 });
	// Let any island on /data settle so its requests never bleed into our navigation window.
	await page.waitForTimeout(500);

	const postsBefore = batchPosts;
	const getsBefore = regionGets;

	await page.locator('[data-nav-batch-link]').click();

	// Wait for the batched page: all four distinct server islands filled from the batch.
	await page.waitForFunction(
		() => document.querySelectorAll('[data-slow-greeting]').length >= 4,
		{ timeout: 8000 }
	).catch(() => {});

	const filled = await page.$$eval('[data-slow-greeting] strong', (els) =>
		els.map((e) => (e.textContent || '').trim())
	);
	const salutations = filled.join(' | ');

	check('navigated to /nav-batch (URL)', new URL(page.url()).pathname === '/nav-batch', page.url());
	check('all four server islands filled', filled.length === 4, `${filled.length}: ${salutations}`);
	check(
		'each island rendered its own distinct call',
		['Alpha', 'Bravo', 'Charlie', 'Delta'].every((s) => salutations.includes(s)),
		salutations
	);

	const posts = batchPosts - postsBefore;
	const gets = regionGets - getsBefore;
	check('batchE: navigation fired exactly ONE batch request', posts === 1, `posts=${posts}`);
	check('batchE: NO per-region endpoint GET (no fetch waterfall)', gets === 0, `gets=${gets}`);

	// Fallbacks must be gone (the batched frames actually swapped in, not left as placeholders).
	const fallbacks = await page.$$eval('[data-fallback]', (els) => els.length);
	check('all fallbacks replaced by batched content', fallbacks === 0, `${fallbacks} left`);

	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e.message)));
	check('no page errors', errors.length === 0, errors.join('; '));
} catch (err) {
	check('nav-batch threw', false, String((err as Error)?.message ?? err));
} finally {
	await browser.close();
}

console.log(out.join('\n'));
process.exit(failures);
