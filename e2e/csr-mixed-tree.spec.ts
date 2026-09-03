// REGRESSION: csr-true context inheritance across a mixed route tree. An option-less (or explicit)
// csr=true ANCESTOR layout injects the csr-true context marker; Svelte context flows to ALL
// descendants, so before the csr-false RESET marker existed, every island in a `csr = false` CHILD
// subtree read `true` (isCsrTrue) and silently degraded to inline — zero <ogygia-region>, no
// hydration, no onMount (se-web-platform /fr/fr/ root cause). Routes: /mixed-root (csr=true host) →
// /mixed-root/sub (csr=false subtree with a wake:'load' island in its layout).
// Usage: pnpm exec playwright test csr-mixed-tree
import { test, check } from './fixtures/index.ts';
import { ONE_RE, REGION_TAG_G_RE } from './fixtures/re.ts';

// Count real <ogygia-region elements (not the string in CSS/scripts).
const region_count = (html: string) => (html.match(REGION_TAG_G_RE) ?? []).length;

test.describe('REGRESSION: csr=false subtree under csr=true ancestor layout — reset marker keeps islands islanding', () => {
	test('SSR: the csr=false subtree emits REAL regions, the csr=true level none', async ({
		baseURL
	}) => {
		// SSR: the csr=false subtree under the csr=true ancestor emits REAL regions…
		const sub = await (await fetch(baseURL + '/mixed-root/sub')).text();
		check(
			'csr=false subtree: <ogygia-region> emitted under csr=true ancestor',
			region_count(sub) >= 1,
			`count=${region_count(sub)}`
		);
		// …and the csr=true level emits none (Kit owns it).
		const top = await (await fetch(baseURL + '/mixed-root')).text();
		check(
			'csr=true ancestor level: zero <ogygia-region>',
			region_count(top) === 0,
			`count=${region_count(top)}`
		);
	});

	test('browser: the island in the csr=false subtree hydrates + mounts', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push('console: ' + m.text());
		});
		await page.goto('/mixed-root/sub', { waitUntil: 'networkidle' });
		await page.waitForTimeout(300);

		const btn = page.locator('[data-dyn-island]');
		check('island present after hydrate', (await btn.count()) === 1);
		const before = await btn.innerText();
		await btn.click();
		await page.waitForTimeout(80);
		const after = await btn.innerText();
		check(
			'island HYDRATED in csr=false subtree (click increments)',
			before !== after && ONE_RE.test(after),
			`${before} -> ${after}`
		);
		check(
			'island onMount ran',
			(await page.evaluate(() => (window as unknown as { __dynMounted?: number }).__dynMounted)) ===
				1
		);
		check('no page errors / hydration mismatches', errors.length === 0, errors.join(' | '));
	});
});
