// REGRESSION: the production `$app/stores` split brain, reproduced end to end.
//
// The shape (seen live on a deployed ogygia 0.5.1 app): a Header island whose FIRST import is
// `$app/stores`, siblings importing the same module LATER in the list, and the same file also
// imported PLAIN by a csr=true page. Under lazy island-graph membership, build order decided
// which `$app/*` each copy got: the header bundled Kit's REAL client store — whose page store
// never populates under csr=false — while its siblings got the shim. `$page.url.pathname` threw
// "Cannot read properties of undefined (reading 'pathname')" during hydrate and the header was
// torn out of the page. The EAGER transitive island-graph walk makes membership deterministic
// (the `?og-region` module-id fork was tried and reverted — it broke scoped-CSS emission), so a
// shared module is shimmed EVERYWHERE, including the csr=true copy.
//
// SECOND LEG (the bcms all-products outage): a shared component reading `$page.data.x.method()`
// in onMount. The shimmed csr=true copy read `data: {}` (the island seed never runs on a
// Kit-booted document), threw inside Kit's synchronous hydrate flush, and killed every mount
// after it. The KIT-WORLD PAGE THREAD fixes this: Kit's generated client entry publishes its
// REAL reactive `page` on `Symbol.for('ogygia.kit-page')` (two appended lines, zero bytes —
// see KIT_PAGE_THREAD in vite/index.ts), and the shims read through it whenever it exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { FAVICON_RE } from './fixtures/re.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const CHUNK_IMPORT_RE = /import[^'"]*['"](\.[^'"]+\.js)['"]/g;
const text = async (page: import('@playwright/test').Page, sel: string) =>
	((await page.locator(sel).textContent()) ?? '').trim();

test.describe('$app/stores split brain', () => {
	test('csr=false: the header hydrates with the shim and reads its own page', async ({ page }) => {
		const errs: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

		await page.goto('/split-brain', { waitUntil: 'networkidle' });
		await expect(page.locator('ogygia-region[data-hydrated] [data-split-header]')).toBeVisible({
			timeout: 8000
		});

		// The original symptom was the header VANISHING after hydration failed.
		await expect(
			page.locator('[data-split-header]'),
			'header still in the DOM after hydration'
		).toHaveCount(1);
		expect(
			await text(page, '[data-split-path]'),
			"header's own $page.url.pathname via $app/stores (the line that crashed)"
		).toBe('/split-brain');
		expect(
			await text(page, '[data-split-child-path]'),
			'level-2 sibling via $app/state (runes) agrees — no split brain'
		).toBe('/split-brain');
		expect(
			await text(page, '[data-split-grandchild-path]'),
			'level-3 leaf via $app/state — mark propagates transitively'
		).toBe('/split-brain');
		// The RACE guard: SharedUrl is a PLAIN component (not a marked island) imported by SplitHeader
		// (island, csr=false) AND directly by /kit (csr=true). prescan never registers it, so without the
		// eager transitive walk its `$app/*` is marked lazily during Rolldown's walk — order-dependent, the
		// exact shape that broke in production. The walk marks it up front, so it always reads the shim.
		expect(
			await text(page, '[data-shared-url]'),
			'shared TRANSITIVE dep (also imported by /kit) reads the shim, not the race'
		).toBe('/split-brain');
		// PAGE DATA leg (the bcms all-products crash): `$page.data.<field>.method()` in onMount.
		// Island world: the document seed populates the shim, so the load's value comes through.
		expect(
			await text(page, '[data-shared-data]'),
			"shared component's $page.data via the seeded shim"
		).toBe('islandworld');
		expect(
			errs.filter((e) => !FAVICON_RE.test(e)),
			'zero page errors (the bug threw a TypeError here)'
		).toEqual([]);
	});

	test("csr=true: the same header renders and reads Kit's real page through the thread", async ({
		page
	}) => {
		// No module-id fork: the header is ONE (shimmed) module. On csr=true the kit-world page thread
		// hands the shim Kit's REAL reactive `page` (url, params, and — the bcms crash — DATA), so the
		// shared copy reads Kit's truth. `$app/state` reads stay live through the thread's getters;
		// `$app/stores` subscribers get a fresh snapshot per notification (island set_page events),
		// which on a Kit page means effectively per-subscription — the documented static-read trade-off.
		const errs: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		await page.goto('/kit', { waitUntil: 'networkidle' });
		await expect(page.locator('[data-split-header]')).toBeVisible({ timeout: 8000 });
		expect(
			await text(page, '[data-split-path]'),
			'the same header reads its own pathname (/kit)'
		).toBe('/kit');
		// PAGE DATA leg (the bcms all-products crash, verbatim shape): the shared component calls a
		// method on `$page.data.<field>` in onMount. The island shim starts with `data: {}` and is
		// NEVER seeded on a Kit-booted document — without the kit-page bridge the read returns
		// undefined, the method call throws inside Kit's synchronous hydrate flush, and every
		// component mount after it dies. The bridge hands the shim Kit's REAL page data.
		expect(
			await text(page, '[data-shared-data]'),
			"shared component's $page.data reads KIT's real page data"
		).toBe('kitworld');
		expect(
			errs.filter((e) => !FAVICON_RE.test(e)),
			'zero page errors (the bcms crash threw here)'
		).toEqual([]);
	});

	test("build output: no copy of the header bundles Kit's real (empty-under-csr=false) client store", () => {
		// `$app/stores`'s real client reads `getContext('__svelte__')`; on a csr=false island that store
		// is never populated → `page.url` undefined → the crash. With the eager walk the header (and its
		// transitive deps) are shimmed in EVERY chunk that carries them, so none bundle `__svelte__`.
		const clientDir = path.join(repo, 'apps/playground/.svelte-kit/output/client/_app/immutable');
		expect(fs.existsSync(clientDir), `client output exists at ${clientDir}`).toBe(true);
		const MARKER = 'og-e2e-split-brain';
		const withMarker: string[] = [];
		const walk = (d: string) => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const f = path.join(d, e.name);
				if (e.isDirectory()) walk(f);
				else if (f.endsWith('.js') && fs.readFileSync(f, 'utf-8').includes(MARKER))
					withMarker.push(path.relative(clientDir, f));
			}
		};
		walk(clientDir);
		expect(withMarker.length, 'the header rendered into the client bundle').toBeGreaterThanOrEqual(
			1
		);
		const leaks: string[] = [];
		for (const rel of withMarker) {
			const chunkPath = path.join(clientDir, rel);
			const closure = [fs.readFileSync(chunkPath, 'utf-8')];
			for (const m of closure[0].matchAll(CHUNK_IMPORT_RE)) {
				const dep = path.resolve(path.dirname(chunkPath), m[1]);
				if (fs.existsSync(dep)) closure.push(fs.readFileSync(dep, 'utf-8'));
			}
			if (closure.some((code) => code.includes('__svelte__'))) leaks.push(rel);
		}
		expect(
			leaks,
			"no copy of the header bundles Kit's real $app/stores (shimmed everywhere)"
		).toEqual([]);
	});
});
