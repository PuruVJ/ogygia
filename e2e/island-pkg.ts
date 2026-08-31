// `ogygia.files` — a dependency DECLARES its compile surface in its own package.json
// (internal/repro-island-pkg: `{ "ogygia": { "files": ["./src/widgets", "./src/pages/**/*.svelte",
// "./src/routes.ts"] } }`), and the plugin gives those paths full app-source citizenship: prescan,
// transform (`.svelte` AND `.ts`), ssr.noExternal, install-independent identities. Three seams:
//   1. /island-pkg — the app imports Panel PLAIN; the island inside it is marked in PACKAGE source.
//   2. /rtr/pkg — DISTRIBUTED ROUTES: a table fragment shipped by the package, spread into the
//      app's router; the page carries its own island (glob-declared page component).
//   3. /rtr/pkg/board — a marked import in the package's .ts table (the node_modules `.ts` gate):
//      before the declaration mechanism this was SILENTLY inert.
// Usage: node e2e/island-pkg.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}

const browser = await chromium.launch();
try {
	// SSR: all three surfaces render server HTML
	const host = await (await fetch(base + '/island-pkg')).text();
	check('SSR: package panel rendered (plain app import)', /data-pkg-panel/.test(host));
	check('SSR: island inside package component present', /data-pkg-island/.test(host));
	const pkg_page = await (await fetch(base + '/rtr/pkg')).text();
	check('SSR: shipped route renders through app router', /data-pkg-page/.test(pkg_page));
	check('SSR: shipped route load ran', /from repro-island-pkg/.test(pkg_page));
	const board = await (await fetch(base + '/rtr/pkg/board')).text();
	check('SSR: .ts-table marked page renders', /data-pkg-board/.test(board));

	const page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push('console: ' + m.text());
	});

	// 1) library-internal island hydrates on the app page
	await page.goto(base + '/island-pkg', { waitUntil: 'networkidle' });
	await page.waitForTimeout(250);
	const tally = page.locator('[data-pkg-island]');
	check('island present after hydrate', (await tally.count()) === 1);
	const t0 = await tally.innerText();
	await tally.click();
	await page.waitForTimeout(80);
	const t1 = await tally.innerText();
	check('package island HYDRATED (click increments)', t0 !== t1 && /4/.test(t1), `${t0} -> ${t1}`);

	// 1b) a SERVER island marked inside the package: the deferred fetch needs the prescan-built
	// signed manifest to know this region — a miss would 403 and the fallback would stay forever.
	const badge = page.locator('[data-pkg-deferred]');
	check('package DEFERRED island filled its hole', (await badge.count()) === 1);
	check('deferred content is the server render', /acme/.test((await badge.innerText()) ?? ''));

	// 2) island inside a SHIPPED ROUTE hydrates (starts at 10 → 11)
	await page.goto(base + '/rtr/pkg', { waitUntil: 'networkidle' });
	await page.waitForTimeout(250);
	const rt = page.locator('[data-pkg-island]');
	await rt.click();
	await page.waitForTimeout(80);
	check('shipped-route island hydrated', /11/.test(await rt.innerText()), await rt.innerText());

	// 3) the .ts-table marked page is ONE live island (the cms /lab pattern)
	await page.goto(base + '/rtr/pkg/board', { waitUntil: 'networkidle' });
	await page.waitForTimeout(250);
	const btn = page.locator('[data-pkg-board-btn]');
	await btn.click();
	await page.waitForTimeout(80);
	check('.ts-gate island alive (board counts)', /1/.test(await btn.innerText()), await btn.innerText());

	check('no page errors / hydration mismatches', errors.length === 0, errors.join(' | '));
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL ISLAND-PKG CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
