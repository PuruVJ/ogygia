// Playwright checks for CLIENT-SIDE remote functions inside islands.
// Requires the server started with ORIGIN set (adapter-node CSRF) for the command POST;
// dev needs no ORIGIN (Kit skips the origin check in dev).
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out = [];
function check(name, cond, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const errs = [];
	page.on('pageerror', (e) => errs.push(e.message));
	// NOTE: don't use networkidle — the live-query SSE stream keeps the connection open.
	await page.goto(base + '/data', { waitUntil: 'domcontentloaded' });

	// SSR mode (a): resolved-at-SSR greeting is in the HTML. In a PROD build the flicker seed makes
	// it resolve synchronously on hydration (no flash); in `vite dev` (no seed) the top-level await
	// re-suspends briefly on hydration, so the text can blank for a frame before the re-fetch lands.
	// Wait for stable presence rather than sampling a single (possibly transient) frame.
	await page.waitForSelector('[data-resolved-greeting]', { timeout: 5000 });
	await page
		.waitForFunction(
			() => document.querySelector('[data-resolved-greeting]')?.textContent?.includes('Hello, world!'),
			{ timeout: 6000 }
		)
		.catch(() => {});
	check('mode (a): resolved greeting present', (await page.locator('[data-resolved-greeting]').textContent()).includes('Hello, world!'));

	// SSR mode (b): pending boundary -> resolves AFTER hydration with fetched data (client query).
	await page.waitForFunction(
		() => document.querySelector('[data-pending-greeting]')?.textContent.includes('Hello, lazily!'),
		{ timeout: 6000 }
	).catch(() => {});
	check('mode (b): pending boundary resolved after hydration (client query fetch)', (await page.locator('[data-pending-greeting]').count()) === 1 && (await page.locator('[data-pending-greeting]').textContent()).includes('Hello, lazily!'));

	// query with reactive .current
	await page.waitForFunction(() => /reactive current: \d+/.test(document.querySelector('[data-remote-counter] [data-current]')?.textContent || ''), { timeout: 6000 }).catch(() => {});
	const currentText = (await page.locator('[data-remote-counter] [data-current]').textContent()).trim();
	check('query: reactive .current populated from client fetch', /reactive current: \d+/.test(currentText), currentText);

	// command mutates server state; query.refresh() shows the change (reactive .current++)
	const before = Number((await page.locator('[data-remote-counter] [data-current]').textContent()).replace(/\D/g, ''));
	await page.locator('[data-bump]').click();
	await page.waitForFunction((b) => {
		const t = document.querySelector('[data-remote-counter] [data-current]')?.textContent || '';
		const n = Number(t.replace(/\D/g, ''));
		return n === b + 1;
	}, before, { timeout: 6000 }).catch(() => {});
	const after = Number((await page.locator('[data-remote-counter] [data-current]').textContent()).replace(/\D/g, ''));
	check('command + query.refresh(): server state mutated & re-fetched', after === before + 1, `${before} -> ${after}`);

	// click twice more, ensure it keeps incrementing (command is really hitting the server)
	await page.locator('[data-bump]').click();
	await page.locator('[data-bump]').click();
	await page.waitForFunction((b) => Number((document.querySelector('[data-remote-counter] [data-current]')?.textContent || '').replace(/\D/g, '')) === b + 3, before, { timeout: 6000 }).catch(() => {});
	const after3 = Number((await page.locator('[data-remote-counter] [data-current]').textContent()).replace(/\D/g, ''));
	check('command: repeated calls accumulate on the server', after3 === before + 3, `${before} -> ${after3}`);

	// query.live: streaming updates the reactive current over time
	const tick1 = (await page.locator('[data-live-current]').textContent()).trim();
	await sleep(1300);
	const tick2 = (await page.locator('[data-live-current]').textContent()).trim();
	check('query.live: SSE stream updates reactive current', tick1 !== tick2 && /\d{4}-\d\d-\d\dT/.test(tick2), `${tick1} -> ${tick2}`);

	// custom transport type revived on the client (Kit's transport decoders, reused via ogygia)
	await page
		.waitForFunction(() => document.querySelector('[data-transport-ok]')?.textContent === 'true', { timeout: 6000 })
		.catch(() => {});
	check('custom transport type round-trips into the island (instanceof true)', (await page.locator('[data-transport-ok]').textContent().catch(() => '')) === 'true');
	check('custom transport value correct (21.5°C)', /21\.5°C/.test((await page.locator('[data-transport-value]').textContent().catch(() => '')) || ''));

	// ---------- query.batch + prerender (task 6), on /remote-batch ----------
	const remoteReqs: string[] = [];
	page.on('request', (r) => {
		const u = r.url();
		if (/\/_app\/remote\//.test(u)) remoteReqs.push(r.method() + ' ' + u.split('/_app/remote/')[1]);
	});
	await page.goto(base + '/remote-batch', { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => document.querySelector('[data-batch-onerun]')?.textContent?.length, { timeout: 6000 }).catch(() => {});
	await sleep(400);

	// query.batch: three simultaneous getSquare() calls collapse into exactly ONE request
	const squareReqs = remoteReqs.filter((u) => /getSquare/.test(u));
	check('query.batch: N simultaneous calls -> exactly ONE network request', squareReqs.length === 1, `${squareReqs.length}: ${squareReqs.join(' | ')}`);
	check('query.batch: request is a POST (batched body)', squareReqs.every((u) => u.startsWith('POST')), squareReqs.join(' | '));
	// per-key results correct + all from one server run (same batchAt) + batch size 3
	const b2 = (await page.locator('[data-batch-2]').textContent()) || '';
	const b5 = (await page.locator('[data-batch-5]').textContent()) || '';
	const b9 = (await page.locator('[data-batch-9]').textContent()) || '';
	check('query.batch: per-key results correct (2²=4, 5²=25, 9²=81)', /2² = 4\b/.test(b2) && /5² = 25\b/.test(b5) && /9² = 81\b/.test(b9), `${b2} / ${b5} / ${b9}`);
	check('query.batch: batch size reported as 3', /size 3/.test(b2) && /size 3/.test(b9), b2);
	check('query.batch: all results from ONE server run (identical batchAt)', (await page.locator('[data-batch-onerun]').textContent()) === 'one batched run');

	// prerender() on a non-prerendered page: renders (SSR + hydration) and is SEEDED inline (Kit
	// csr=true parity — `p` → `prerender_responses`), so the client resolves it synchronously and does
	// NOT re-fetch. Re-fetching a prerender remote awaited inside an island re-renders/re-mounts it on
	// hydrate — the async-island FOUC. This asserts the seed path so that regression can't come back.
	await page.waitForFunction(() => document.querySelector('[data-prerender-text]')?.textContent === 'islands, not hydration', { timeout: 6000 }).catch(() => {});
	check('prerender: renders on a non-prerendered page', (await page.locator('[data-prerender-text]').textContent()) === 'islands, not hydration');
	const manifestoReqs = remoteReqs.filter((u) => /getManifesto/.test(u));
	check('prerender: seeded inline, no client re-fetch (FOUC guard)', manifestoReqs.length === 0, manifestoReqs.join(' | ') || '(none = seeded)');

	check('no unexpected page errors', errs.length === 0, errs.slice(0, 2).join('; '));
	await page.close();
} finally {
	await browser.close();
}
console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL REMOTE CHECKS PASSED' : failures + ' REMOTE CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
