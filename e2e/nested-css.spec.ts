// NESTED ISLAND CSS — an island inside an island must link its own stylesheet from the render.
//
// REGRESSION (a field page, 2026-10-06): a CMS block island (a product-cards carousel) rendered
// inside a CMS container island (a tab container). Inner islands load their component LAZILY (the
// client wrapper's `await import(entry)`), and an island's CSS list is its chunk closure over STATIC
// edges, so the outer island's list never carried the inner one's sheet — and Region skipped the
// inner island's own CSS ("nested rides the parent's closure"). The inner sheet existed in the build
// but reached the page in neither form; a CMS registry lookup at render time hid it twice over.
//
// The outer island here is `wake: 'interaction'`, so nothing wakes during the checks. Guards:
//   (1) both inner islands' tokens are in the page's CSS (linked sheets fetched + inline styles);
//   (2) in the browser both inner islands are styled before any interaction.
// Usage: pnpm exec playwright test nested-css
import { test, check } from './fixtures/index.ts';

const STYLESHEET_LINK_G = /<link\b[^>]*rel="stylesheet"[^>]*>/g;
const INLINE_STYLE_G = /<style\b[^>]*>([^<]*)<\/style>/g;
const HREF_RE = /href="([^"]+)"/;
const TOKENS = ['nctoken-inner', 'nctoken-registry'];

test.describe('NESTED ISLAND CSS: an inner island links its own sheet', () => {
	test('SSR: both inner islands’ sheets reach the page while the outer island sleeps', async ({
		baseURL
	}) => {
		const url = baseURL + '/nested-css';
		const res = await fetch(url);
		const html = await res.text();
		check('/nested-css returns 200', res.status === 200);
		check('the outer island SSR-rendered both inner islands', html.includes('data-nc-inner') && html.includes('data-nc-registry'));
		let css = '';
		for (const tag of html.match(STYLESHEET_LINK_G) ?? []) {
			const href = tag.match(HREF_RE)?.[1];
			if (!href) continue;
			const r = await fetch(new URL(href, url).href);
			css += (await r.text()) + '\n';
		}
		for (const m of html.matchAll(INLINE_STYLE_G)) css += m[1] + '\n';
		for (const tok of TOKENS) check(`inner island sheet on the page (${tok})`, css.includes(tok));
	});

	test('browser: both inner islands are styled before the outer island wakes', async ({ page }) => {
		await page.goto('/nested-css', { waitUntil: 'domcontentloaded' });
		const outline = (sel: string) =>
			page
				.locator(sel)
				.evaluate((el) => getComputedStyle(el).outlineColor)
				.catch(() => '');
		check('outer island still asleep', (await page.locator('ogygia-region[data-hydrated]').count()) === 0);
		check('direct inner island styled', (await outline('[data-nc-inner]')) === 'rgb(9, 176, 84)');
		check('registry inner island styled', (await outline('[data-nc-registry]')) === 'rgb(9, 176, 84)');
	});
});
