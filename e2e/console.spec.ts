// Console cleanliness: zero `hydration_mismatch` warnings across representative pages,
// INCLUDING `/lakes` (the lake lift/restore path must seed empty Boundary+Placeholder anchors
// so Svelte does not warn).
//
//   pnpm exec playwright test console                       # prod/preview (baseURL from config)
//                                                           # against vite dev: warnings are DEV-noisy;
//                                                           # hydration_mismatch is DEV-only
import { test, expect } from './fixtures/index.ts';

const PAGES = [
	'/',
	'/about',
	'/data',
	'/static',
	'/plain',
	'/kit',
	'/dashboard/orders',
	'/dashboard/orders/3',
	'/dashboard/analytics',
	'/dashboard/settings',
	'/lakes'
];

test.describe('zero hydration_mismatch across pages (incl. /lakes)', () => {
	for (const p of PAGES) {
		test(`${p} is clean`, async ({ page }) => {
			const hits: string[] = [];
			page.on('console', (msg) => {
				if (msg.text().includes('hydration_mismatch')) hits.push(msg.text().slice(0, 80));
			});
			await page.goto(p, { waitUntil: 'domcontentloaded' }).catch(() => {});
			await page.waitForTimeout(1200);
			expect(hits, `${p} clean of hydration_mismatch (${hits.length})`).toEqual([]);
		});
	}
});
