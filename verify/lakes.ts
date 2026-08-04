// LAKES: a `hydrate: 'none'` component INSIDE a hydrated island is a frozen region. This suite
// proves the full alternation shell -> island -> lake -> island-in-lake, plus the two guarantees
// that make a lake a lake: its component code ships in NO client chunk, and its DOM is frozen
// (events inert) yet an island authored inside it self-hydrates. Also exercises `lake_restore`
// re-creation on an {#if} toggle.
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
const client_dir = join(repo, 'playground', '.svelte-kit', 'output', 'client');
const server_dir = join(repo, 'playground', '.svelte-kit', 'output', 'server');

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

	// SSR structure: exactly one lake region (no hydrate attr) + one inner island region (hydrate).
	check('lake emitted as <ogygia-region data-lake> WITHOUT a hydrate attr (non-boundary)', (await page.locator('ogygia-region[data-lake]').count()) === 1);
	check('lake region has NO hydrate attribute', (await page.locator('ogygia-region[data-lake][hydrate]').count()) === 0);

	// Frozen content is present (SSR rendered inline, restored around parent hydration).
	check('lake SSR content present after hydration (lifted + restored)', (await page.locator('[data-frozen-box]').count()) === 1);

	// Outer island hydrated + interactive.
	const c0 = (await page.locator('[data-count-btn]').textContent()).trim();
	await page.locator('[data-count-btn]').click();
	const c1 = (await page.locator('[data-count-btn]').textContent()).trim();
	check('outer island hydrates & is interactive', c0 !== c1 && /island count: 1/.test(c1), `${c0} -> ${c1}`);

	// Island-in-lake self-hydrates (the lake reset its subtree to dead — nearest-boundary rule).
	const i0 = (await page.locator('[data-inner-btn]').textContent().catch(() => '')).trim();
	await page.locator('[data-inner-btn]').click();
	const i1 = (await page.locator('[data-inner-btn]').textContent().catch(() => '')).trim();
	check('island INSIDE the lake self-hydrates & works (alternation)', i0 !== i1 && /: 1/.test(i1), `${i0} -> ${i1}`);

	// The lake itself is FROZEN: its own button is inert (no JS shipped).
	const f0 = (await page.locator('[data-frozen-btn]').textContent()).trim();
	await page.locator('[data-frozen-btn]').click();
	await sleep(150);
	const f1 = (await page.locator('[data-frozen-btn]').textContent()).trim();
	check('lake is frozen: its button is inert (no client JS, events do nothing)', f0 === f1 && /frozen button: 0/.test(f1), `${f0} -> ${f1}`);

	// lake_restore: 'cache' (the playground default) — an {#if} toggle re-creates the region and the
	// frozen DOM is re-inserted; the inner island re-hydrates.
	await page.locator('[data-toggle-btn]').click();
	await sleep(250);
	const gone = (await page.locator('[data-frozen-box]').count()) === 0;
	await page.locator('[data-toggle-btn]').click();
	await sleep(400);
	const back = (await page.locator('[data-frozen-box]').count()) === 1;
	const innerBack = (await page.locator('[data-inner-btn]').count()) === 1;
	check("lake_restore 'cache': {#if}-toggle off removes the lake", gone);
	check("lake_restore 'cache': {#if}-toggle on re-inserts the frozen DOM + re-hydrates inner island", back && innerBack);

	await page.close();
} finally {
	await browser.close();
}
console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL LAKE CHECKS PASSED' : failures + ' LAKE CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
