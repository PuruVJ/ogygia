// LAKES: a `wake: 'none'` component INSIDE a hydrated island is a frozen region. This suite
// proves the full alternation shell -> island -> lake -> island-in-lake, plus the two guarantees
// that make a lake a lake: its component code ships in NO client chunk, and its DOM is frozen
// (events inert) yet an island authored inside it self-hydrates. Also exercises remount:'cache'
// and remount:'swr' on {#if} toggle.
//
//   node verify/lakes.ts http://localhost:3051   # a PRODUCTION build (preview/adapter output)
//
// The client-chunk-exclusion assertion reads the playground's client build output, so it only runs
// when that directory exists (a prod build); pass any base URL for the browser checks.
import { chromium } from 'playwright';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out = [];
function check(name, cond, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The distinctive string embedded in the lake component (FrozenBox). It must appear in the SERVER
// build (the lake SSRs inline) and in NO client chunk (its JS is swapped for a placeholder).
const MARKER = 'FROZEN_LAKE_CODE_MARKER_9f3a';
const repo = fileURLToPath(new URL('..', import.meta.url));
const client_dir = join(repo, 'apps/playground', '.svelte-kit', 'output', 'client');
const server_dir = join(repo, 'apps/playground', '.svelte-kit', 'output', 'server');

function grep_dir(dir) {
	let hits = 0;
	const walk = (d) => {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(d, e.name);
			if (e.isDirectory()) walk(full);
			else if (/\.(js|mjs)$/.test(e.name) && readFileSync(full, 'utf-8').includes(MARKER)) hits++;
		}
	};
	walk(dir);
	return hits;
}

// --- build-output guarantee: the lake's code is excluded from every client chunk ---------------
if (existsSync(client_dir)) {
	const client_hits = grep_dir(client_dir);
	const server_hits = grep_dir(server_dir);
	check('lake code ships in NO client chunk (frozen: its JS never reaches the browser)', client_hits === 0, `${client_hits} client chunk(s)`);
	check('lake code IS in the server build (it SSRs inline)', server_hits >= 1, `${server_hits} server file(s)`);
} else {
	out.push('SKIP  client-chunk exclusion (no prod build output — run against a preview/prod build)');
}

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const remoteErrs = [];
	page.on('pageerror', (e) => remoteErrs.push(e.message));
	await page.goto(base + '/lakes', { waitUntil: 'load' });
	await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 6000 }).catch(() => {});
	await sleep(1500);

	// SSR structure: frozen region (`wake="none"`) + remount attr (default cache).
	check(
		'frozen region emitted as <ogygia-region wake="none">',
		(await page.locator('ogygia-region[wake="none"]').count()) >= 1
	);
	check(
		'default remount is cache on hydrate=none',
		(await page.locator('ogygia-region[wake="none"][remount="cache"]').count()) >= 1
	);

	// Frozen content is present (SSR rendered inline, restored around parent hydration).
	check('lake SSR content present after hydration (lifted + restored)', (await page.locator('[data-frozen-box]').count()) >= 1);

	// Outer island hydrated + interactive (first LakeCounter).
	const c0 = (await page.locator('[data-count-btn]').first().textContent()).trim();
	await page.locator('[data-count-btn]').first().click();
	const c1 = (await page.locator('[data-count-btn]').first().textContent()).trim();
	check('outer island hydrates & is interactive', c0 !== c1 && /island count: 1/.test(c1), `${c0} -> ${c1}`);

	// Island-in-lake self-hydrates (the lake reset its subtree to dead — nearest-boundary rule).
	const i0 = (await page.locator('[data-inner-btn]').first().textContent().catch(() => '')).trim();
	await page.locator('[data-inner-btn]').first().click();
	const i1 = (await page.locator('[data-inner-btn]').first().textContent().catch(() => '')).trim();
	check('island INSIDE the lake self-hydrates & works (alternation)', i0 !== i1 && /: 1/.test(i1), `${i0} -> ${i1}`);

	// The lake itself is FROZEN: its own button is inert (no JS shipped).
	const f0 = (await page.locator('[data-frozen-btn]').first().textContent()).trim();
	await page.locator('[data-frozen-btn]').first().click();
	await sleep(150);
	const f1 = (await page.locator('[data-frozen-btn]').first().textContent()).trim();
	check('lake is frozen: its button is inert (no client JS, events do nothing)', f0 === f1 && /frozen button: 0/.test(f1), `${f0} -> ${f1}`);

	// remount: 'cache' — {#if} toggle re-creates the region and the frozen DOM is re-inserted.
	const boxesBefore = await page.locator('[data-frozen-box]').count();
	await page.locator('[data-toggle-btn]').first().click();
	await sleep(250);
	const boxesHidden = await page.locator('[data-frozen-box]').count();
	await page.locator('[data-toggle-btn]').first().click();
	await sleep(400);
	const boxesRestored = await page.locator('[data-frozen-box]').count();
	check("remount 'cache': {#if}-toggle off removes a lake", boxesHidden < boxesBefore);
	check("remount 'cache': {#if}-toggle on re-inserts the frozen DOM", boxesRestored === boxesBefore);
	check("remount 'cache': inner island present after restore", (await page.locator('[data-inner-btn]').count()) >= 1);

	// remount: swr — second demo; toggle triggers a region endpoint fetch after paint.
	const swrRoot = page.locator('[data-swr-demo]');
	if ((await swrRoot.count()) === 1) {
		const fetches = [];
		page.on('request', (req) => {
			const u = req.url();
			if (u.includes('ogygia') || decodeURIComponent(u).includes('__ogygia__')) fetches.push(u);
		});
		const stampBefore = await swrRoot.locator('[data-frozen-stamp]').first().getAttribute('data-frozen-stamp').catch(() => null);
		await swrRoot.locator('[data-toggle-btn]').click();
		await sleep(200);
		await swrRoot.locator('[data-toggle-btn]').click();
		await sleep(800);
		check("remount 'swr': {#if}-toggle triggers region endpoint fetch", fetches.length >= 1, `${fetches.length} fetch(es)`);
		const revalidated = await swrRoot.locator('ogygia-region[wake="none"][data-revalidated]').count();
		check("remount 'swr': region marked data-revalidated after fetch", revalidated >= 1, `${revalidated}`);
		if (stampBefore != null) {
			const stampAfter = await swrRoot.locator('[data-frozen-stamp]').first().getAttribute('data-frozen-stamp');
			check(
				"remount 'swr': paints fresh SSR (stamp advances)",
				stampAfter != null && stampAfter !== stampBefore,
				`${stampBefore} -> ${stampAfter}`
			);
		} else {
			out.push('SKIP  remount swr stamp freshness (no data-frozen-stamp in build)');
		}
		check(
			"remount 'swr': inner island present after revalidate",
			(await swrRoot.locator('[data-inner-btn]').count()) >= 1
		);
	} else {
		out.push('SKIP  remount swr demo (no [data-swr-demo] on page)');
	}

	// ── REGRESSION: two same-component lakes in one island keep their OWN content ──────────────────
	// lift/restore pairs lifted frozen DOM back by POSITION; a shared entry id must not funnel both
	// frags into the first box (which left the second empty before the fix).
	await page.goto(base + '/two-lakes', { waitUntil: 'load' });
	await sleep(300);
	const first = page.locator('[data-tlh-first] [data-frozen-box]');
	const second = page.locator('[data-tlh-second] [data-frozen-box]');
	check('two lakes: both frozen boxes present', (await first.count()) === 1 && (await second.count()) === 1);
	const firstLabel = await page.locator('[data-tlh-first] [data-frozen-label]').textContent().catch(() => null);
	const secondLabel = await page.locator('[data-tlh-second] [data-frozen-label]').textContent().catch(() => null);
	check('first lake kept its OWN content', firstLabel?.trim() === 'alpha-lake', `first=${firstLabel}`);
	check('second lake kept its OWN content (not empty / not the first lake\'s)', secondLabel?.trim() === 'beta-lake', `second=${secondLabel}`);

	await page.close();
} finally {
	await browser.close();
}
console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL LAKE CHECKS PASSED' : failures + ' LAKE CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
