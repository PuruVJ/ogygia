// REGRESSION: a csr=true PAGE under a csr=false LAYOUT that carries wake:load chrome islands
// (header + footer). Kit hydrates the whole document there, so the layout's islands must degrade to
// plain inline components on BOTH legs — otherwise they SSR as <ogygia-region>, desync at Kit
// hydrate, and VANISH (the bug this locks). Also asserts the csr=true page ships ZERO ogygia
// (no runtime, no dev-hmr, no region tag), while the csr=false sibling keeps its islands.
//
//   pnpm exec playwright test csr-chrome
import { test, check, sleep } from './fixtures/index.ts';
import { CHROME_HEADER_RE, REGION_TAG_RE, RUNTIME_SCRIPT_RE } from './fixtures/re.ts';

// hoisted probes for the deep-dynamic block
const FOOTER_RE = /data-chrome-footer/;
const DEV_HMR_RE = /data-ogygia-dev-hmr/;

test.describe('REGRESSION: csr=true page under a csr=false layout w/ wake:load chrome — islands degrade inline (no vanish, zero ogygia)', () => {
	test('the csr=true page under the csr=false chrome layout', async ({ page, baseURL }) => {
		const errs: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		// raw SSR HTML first — the runtime/dev-hmr must never be injected on a csr=true page
		const html = await (await fetch(baseURL + '/csr-chrome/kit/')).text();
		check('csr=true page ships NO ogygia runtime script', !RUNTIME_SCRIPT_RE.test(html));
		check('csr=true page ships NO ogygia dev-hmr script', !DEV_HMR_RE.test(html));
		check('csr=true SSR has NO <ogygia-region> element', !REGION_TAG_RE.test(html));
		check(
			'csr=true SSR renders the chrome inline',
			CHROME_HEADER_RE.test(html) && FOOTER_RE.test(html)
		);

		await page.goto('/csr-chrome/kit/', { waitUntil: 'networkidle' });
		await sleep(500);
		check(
			'csr=true: header SURVIVED hydration (did not vanish)',
			(await page.locator('[data-chrome-header]').count()) === 1
		);
		check(
			'csr=true: footer SURVIVED hydration (did not vanish)',
			(await page.locator('[data-chrome-footer]').count()) === 1
		);
		check(
			'csr=true: ZERO ogygia-region after hydration (degraded to plain)',
			(await page.locator('ogygia-region').count()) === 0
		);
		const hbtn = page.locator('[data-chrome-header] button');
		await hbtn.click();
		await hbtn.click();
		check(
			'csr=true: chrome island interactive via Kit hydration',
			(await hbtn.textContent())!.includes('h:2')
		);
		check('csr=true: no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
	});

	// ── consumer-reported shape: csr=true at a (group) + [matcher] DYNAMIC leaf ──
	// The server leg matches Kit's runtime route.id (groups stripped, matcher segments verbatim)
	// against the filesystem-derived set — a dynamic deeply-nested route must degrade like a
	// static one, or islands ship with Kit's bootstrap and no runtime (dead chrome).
	test('consumer-reported shape: csr=true at a (group) + [matcher] DYNAMIC leaf', async ({
		page,
		baseURL
	}) => {
		const errs: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		const html = await (await fetch(baseURL + '/csr-chrome/deep/anything/')).text();
		check('deep dynamic csr=true: SSR has NO <ogygia-region>', !REGION_TAG_RE.test(html));
		check('deep dynamic csr=true: chrome rendered inline', CHROME_HEADER_RE.test(html));
		check('deep dynamic csr=true: NO ogygia runtime shipped', !RUNTIME_SCRIPT_RE.test(html));

		await page.goto('/csr-chrome/deep/anything/', { waitUntil: 'networkidle' });
		await sleep(500);
		check(
			'deep dynamic: ZERO ogygia-region after hydration',
			(await page.locator('ogygia-region').count()) === 0
		);
		check(
			'deep dynamic: header survived hydration',
			(await page.locator('[data-chrome-header]').count()) === 1
		);
		const hbtn = page.locator('[data-chrome-header] button');
		await hbtn.click();
		check(
			'deep dynamic: chrome interactive via Kit hydration',
			(await hbtn.textContent())!.includes('h:1')
		);
		check('deep dynamic: no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
	});

	test('the csr=false sibling under the SAME layout keeps its islands', async ({ page }) => {
		const errs: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		await page.goto('/csr-chrome/', { waitUntil: 'networkidle' });
		await sleep(500);
		check(
			'csr=false sibling: chrome renders as islands',
			(await page.locator('ogygia-region').count()) >= 2
		);
		check(
			'csr=false sibling: header present',
			(await page.locator('[data-chrome-header]').count()) === 1
		);
		const hbtn = page.locator('[data-chrome-header] button');
		await hbtn.click();
		check('csr=false sibling: island interactive', (await hbtn.textContent())!.includes('h:1'));
		check('csr=false sibling: no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
	});
});
