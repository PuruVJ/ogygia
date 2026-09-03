// REGRESSION: an island HOST that lives in a workspace sub-package which does NOT depend on ogygia
// (`internal/repro-subpkg`, imported by the playground at /subpkg-island). The ogygia transform
// injects `ogygia/internal` / `ogygia/internal/server` into that host + its generated island module;
// a bare specifier would resolve from the sub-package (no ogygia there) and the BUILD would fail:
//   Rolldown failed to resolve import "ogygia/internal" from ".../repro-subpkg/.../Toolbar.svelte"
// The plugin re-bases those injected imports off ogygia's OWN package (PKG_ROOT self-reference), so
// the build succeeds AND the island hydrates. If this file's page even SSRs, the build already passed
// the resolution; the click proves the island came alive.
// Usage: pnpm exec playwright test subpkg-island
import { test, check } from './fixtures/index.ts';
import { ONE_RE } from './fixtures/re.ts';

const SUBPKG_TOOLBAR_RE = /data-subpkg-toolbar/;
const SUBPKG_ISLAND_RE = /data-subpkg-island/;

test.describe('REGRESSION: island host in a workspace sub-package w/o ogygia dep — injected ogygia/internal resolves (self-ref) + hydrates', () => {
	test('SSR: the sub-package island rendered → the build resolved the injected ogygia imports', async ({
		baseURL
	}) => {
		const raw = await (await fetch(baseURL + '/subpkg-island')).text();
		check('SSR: sub-package island host rendered', SUBPKG_TOOLBAR_RE.test(raw));
		check('SSR: sub-package island present', SUBPKG_ISLAND_RE.test(raw));
	});

	test('browser: the sub-package island hydrates (click increments)', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push('console: ' + m.text());
		});
		await page.goto('/subpkg-island', { waitUntil: 'networkidle' });
		await page.waitForTimeout(250);

		const btn = page.locator('[data-subpkg-island]');
		check('island present after hydrate', (await btn.count()) === 1);
		const before = await btn.innerText();
		await btn.click();
		await page.waitForTimeout(80);
		const after = await btn.innerText();
		check(
			'sub-package island HYDRATED (click increments)',
			before !== after && ONE_RE.test(after),
			`${before} -> ${after}`
		);
		check('no page errors / hydration mismatches', errors.length === 0, errors.join(' | '));
	});
});
