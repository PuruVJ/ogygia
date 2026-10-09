// A component that uses `<Region>` DIRECTLY (the held API, wrapping an INTERACTIVE dual) used two
// ways in the SAME build:
//   • /region-mixed     (csr=false) → RegionInside as an ISLAND — ogygia hydrates it, the nested
//     Region rides the parent island.
//   • /region-mixed-kit (csr=true)  → RegionInside as a PLAIN component — Kit hydrates the whole
//     tree and the inner `<ogygia-region>` detects Kit already did it and steps aside. It must NOT
//     double-render or crash.
//
// NOTE the asymmetry this test pins down: a directly-used `<Region>` is NOT stripped the way the
// `with { wake }` import sugar is (that sugar becomes a plain import on csr=true → zero ogygia,
// guarded by fetch-checks.ts / mixed.ts on /kit). A direct `<Region>` still emits an
// `<ogygia-region>` + runtime script on csr=true — so it lives on its OWN csr=true route here, and
// the guarantee is "degrades gracefully to Kit", not "ships zero ogygia".
//
//   pnpm exec playwright test region-mixed

import type { Page } from '@playwright/test';
import { test, check, sleep } from './fixtures/index.ts';
import { FAVICON_RE } from './fixtures/re.ts';

async function probe(page: Page, pathname: string) {
	const errors: string[] = [];
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
	page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
	await page.goto(pathname, { waitUntil: 'networkidle', timeout: 60000 });
	await page.waitForSelector('[data-region-inside]', { timeout: 8000 }).catch(() => {});
	const widget = page.locator('[data-inner-widget]');
	await widget.waitFor({ timeout: 8000 }).catch(() => {});
	const before = ((await widget.textContent().catch(() => '')) || '').trim();
	await widget.click().catch(() => {});
	await widget.click().catch(() => {});
	await sleep(200);
	const after = ((await widget.textContent().catch(() => '')) || '').trim();
	const dom = await page.evaluate(() => ({
		regionInside: document.querySelectorAll('[data-region-inside]').length,
		widget: document.querySelectorAll('[data-inner-widget]').length,
		regionEls: document.querySelectorAll('ogygia-region').length,
		runtimeScript: !!document.querySelector('script[data-ogygia-runtime]')
	}));
	return { before, after, dom, errors: errors.filter((e) => !FAVICON_RE.test(e)) };
}

test.describe('direct <Region> in a component: island on csr=false, plain (Kit-hydrated) on csr=true', () => {
	test('csr=false: RegionInside as an island (ogygia hydrates it — unchanged)', async ({
		page
	}) => {
		const a = await probe(page, '/region-mixed');
		check(
			'csr=false: RegionInside rendered once',
			a.dom.regionInside === 1,
			`count=${a.dom.regionInside}`
		);
		check(
			'csr=false: inner widget present exactly once',
			a.dom.widget === 1,
			`count=${a.dom.widget}`
		);
		check('csr=false: inner widget SSR value (start=5)', a.before.includes('count is 5'), a.before);
		check(
			'csr=false: inner widget hydrated (2 clicks → 7)',
			a.after.includes('count is 7'),
			a.after
		);
		check(
			'csr=false: the region IS an island here (<ogygia-region> + runtime present)',
			a.dom.regionEls >= 1 && a.dom.runtimeScript,
			`els=${a.dom.regionEls} runtime=${a.dom.runtimeScript}`
		);
		check('csr=false: zero page/console errors', a.errors.length === 0, a.errors[0] ?? '');
	});

	test('csr=true: RegionInside as a PLAIN component — renders in the Kit tree', async ({
		page
	}) => {
		// The boundary is CLEAN: a direct <Region> now degrades to a plain component on csr=true, so
		// the page ships ZERO ogygia — no <ogygia-region>, no runtime — and Kit owns hydration.
		const b = await probe(page, '/region-mixed-kit');
		check(
			'csr=true: RegionInside rendered once (no crash)',
			b.dom.regionInside === 1,
			`count=${b.dom.regionInside}`
		);
		check(
			'csr=true: inner widget present exactly once (single hydration)',
			b.dom.widget === 1,
			`count=${b.dom.widget}`
		);
		check('csr=true: inner widget SSR value (start=7)', b.before.includes('count is 7'), b.before);
		check(
			'csr=true: inner widget hydrated by Kit (2 clicks → 9)',
			b.after.includes('count is 9'),
			b.after
		);
		check(
			'csr=true: ZERO <ogygia-region> — the region rendered inline in the Kit tree',
			b.dom.regionEls === 0,
			`count=${b.dom.regionEls}`
		);
		check(
			'csr=true: NO ogygia runtime script — Kit owns hydration',
			b.dom.runtimeScript === false,
			`runtime=${b.dom.runtimeScript}`
		);
		check('csr=true: zero page/console errors', b.errors.length === 0, b.errors[0] ?? '');
	});
});
