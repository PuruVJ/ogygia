// `ogygia.files` — a dependency DECLARES its compile surface in its own package.json
// (internal/repro-island-pkg: `{ "ogygia": { "files": ["./src/widgets", "./src/pages/**/*.svelte",
// "./src/routes.ts"] } }`), and the plugin gives those paths full app-source citizenship: prescan,
// transform (`.svelte` AND `.ts`), ssr.noExternal, install-independent identities. Three seams:
//   1. /island-pkg — the app imports Panel PLAIN; the island inside it is marked in PACKAGE source.
//   2. /rtr/pkg — DISTRIBUTED ROUTES: a table fragment shipped by the package, spread into the
//      app's router; the page carries its own island (glob-declared page component).
//   3. /rtr/pkg/board — a marked import in the package's .ts table (the node_modules `.ts` gate):
//      before the declaration mechanism this was SILENTLY inert.
// Usage: pnpm exec playwright test island-pkg
import { test, check } from './fixtures/index.ts';
import { ONE_RE } from './fixtures/re.ts';

const PKG_PANEL_RE = /data-pkg-panel/;
const PKG_ISLAND_RE = /data-pkg-island/;
const PKG_PAGE_RE = /data-pkg-page/;
const FROM_PKG_RE = /from repro-island-pkg/;
const PKG_BOARD_RE = /data-pkg-board/;
const FOUR_RE = /4/;
const ACME_RE = /acme/;
const ELEVEN_RE = /11/;

test.describe('ogygia.files: dependency-declared compile surface — package-internal islands + distributed routes + .ts-table marks compile and hydrate', () => {
	test('SSR: all three surfaces render server HTML', async ({ baseURL }) => {
		const host = await (await fetch(baseURL + '/island-pkg')).text();
		check('SSR: package panel rendered (plain app import)', PKG_PANEL_RE.test(host));
		check('SSR: island inside package component present', PKG_ISLAND_RE.test(host));
		const pkg_page = await (await fetch(baseURL + '/rtr/pkg')).text();
		check('SSR: shipped route renders through app router', PKG_PAGE_RE.test(pkg_page));
		check('SSR: shipped route load ran', FROM_PKG_RE.test(pkg_page));
		const board = await (await fetch(baseURL + '/rtr/pkg/board')).text();
		check('SSR: .ts-table marked page renders', PKG_BOARD_RE.test(board));
	});

	test('browser: package-internal island, deferred island, shipped route, .ts-table page all hydrate', async ({
		page
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push('console: ' + m.text());
		});

		// 1) library-internal island hydrates on the app page
		await page.goto('/island-pkg', { waitUntil: 'networkidle' });
		await page.waitForTimeout(250);
		const tally = page.locator('[data-pkg-island]');
		check('island present after hydrate', (await tally.count()) === 1);
		const t0 = await tally.innerText();
		await tally.click();
		await page.waitForTimeout(80);
		const t1 = await tally.innerText();
		check(
			'package island HYDRATED (click increments)',
			t0 !== t1 && FOUR_RE.test(t1),
			`${t0} -> ${t1}`
		);

		// 1b) a SERVER island marked inside the package: the deferred fetch needs the prescan-built
		// signed manifest to know this region — a miss would 403 and the fallback would stay forever.
		const badge = page.locator('[data-pkg-deferred]');
		check('package DEFERRED island filled its hole', (await badge.count()) === 1);
		check('deferred content is the server render', ACME_RE.test((await badge.innerText()) ?? ''));

		// 2) island inside a SHIPPED ROUTE hydrates (starts at 10 → 11)
		await page.goto('/rtr/pkg', { waitUntil: 'networkidle' });
		await page.waitForTimeout(250);
		const rt = page.locator('[data-pkg-island]');
		await rt.click();
		await page.waitForTimeout(80);
		check(
			'shipped-route island hydrated',
			ELEVEN_RE.test(await rt.innerText()),
			await rt.innerText()
		);

		// 3) the .ts-table marked page is ONE live island (the cms /lab pattern)
		await page.goto('/rtr/pkg/board', { waitUntil: 'networkidle' });
		await page.waitForTimeout(250);
		const btn = page.locator('[data-pkg-board-btn]');
		await btn.click();
		await page.waitForTimeout(80);
		check(
			'.ts-gate island alive (board counts)',
			ONE_RE.test(await btn.innerText()),
			await btn.innerText()
		);

		check('no page errors / hydration mismatches', errors.length === 0, errors.join(' | '));
	});
});
