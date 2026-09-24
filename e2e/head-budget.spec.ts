// HEAD BUDGET — what a csr=false page links is decided by what it RENDERS, not by its module graph.
//
// REGRESSION (a field landing page, 2026-09-09): a `.ts` block registry with 337 `wake:'visible'`
// marks was imported by a csr=false page. Every mark's wrapper rode Kit's client graph for that page
// node, so Kit linked 163 render-blocking stylesheets (and their chunks) for 21 rendered islands —
// FCP/LCP roughly doubled. No test counted head links; every CSS test asserted presence only.
//
// The page here has a six-block registry (one placed by reference), a directly placed island, and
// a marked import never placed. Guards:
//   (1) every linked stylesheet is fetched and grepped: the two RENDERED islands' tokens are present,
//       the five unplaced registry blocks' and the unused mark's tokens are absent;
//   (2) the head carries a small, fixed number of stylesheet + modulepreload links (a budget — any
//       leak of an unrendered mark grows it and fails here);
//   (3) in the browser the rendered islands are styled (their CSS actually applied).
// Usage: pnpm exec playwright test head-budget
import { test, check } from './fixtures/index.ts';
import { KIT_MARKER_RE } from './fixtures/re.ts';

const STYLESHEET_LINK_G = /<link\b[^>]*rel="stylesheet"[^>]*>/g;
const MODULEPRELOAD_LINK_G = /<link\b[^>]*rel="modulepreload"[^>]*>/g;
const INLINE_REGION_STYLE_G = /<style data-ogygia-region-css="[^"]*">([^<]*)<\/style>/g;
const HREF_RE = /href="([^"]+)"/;
const RENDERED = ['hbtoken-a', 'hbtoken-direct'];
const UNRENDERED = ['hbtoken-b', 'hbtoken-c', 'hbtoken-d', 'hbtoken-e', 'hbtoken-f', 'hbtoken-unused'];
// The budget. Stylesheets: the app's own sheet(s) + one per rendered island (two). Preloads: the
// `load` island's entry + its chunk closure (measured 14: one `og-region.*.js` + 13 shared chunks).
// Generous enough for chunking drift, tight enough that six leaked registry sheets trip it — and
// the token greps below catch a single leaked sheet regardless of the count.
const MAX_STYLESHEETS = 5;
const MAX_MODULEPRELOADS = 24;

test.describe('HEAD BUDGET: a csr=false page links only what it renders', () => {
	test('SSR: linked stylesheets carry the rendered islands only, within budget', async ({
		baseURL
	}) => {
		const res = await fetch(baseURL + '/head-budget');
		const html = await res.text();
		check('/head-budget returns 200', res.status === 200);
		check('/head-budget ships NO Kit bootstrap (csr=false)', !KIT_MARKER_RE.test(html));
		const sheets = (html.match(STYLESHEET_LINK_G) ?? []).map((t) => t.match(HREF_RE)?.[1] ?? '');
		const preloads = (html.match(MODULEPRELOAD_LINK_G) ?? []).map((t) => t.match(HREF_RE)?.[1] ?? '');
		check(
			`stylesheet links within budget (${sheets.length} ≤ ${MAX_STYLESHEETS})`,
			sheets.length <= MAX_STYLESHEETS,
			sheets.join('\n')
		);
		check(
			`modulepreload links within budget (${preloads.length} ≤ ${MAX_MODULEPRELOADS})`,
			preloads.length <= MAX_MODULEPRELOADS,
			preloads.join('\n')
		);
		// Fetch every linked sheet and grep the tokens.
		let css = '';
		for (const href of sheets) {
			const r = await fetch(new URL(href, baseURL).href);
			css += (await r.text()) + '\n';
		}
		// The region-css channel's other shape: a rendered island's sheet under the playground's
		// `kit.inlineStyleThreshold` is a `<style data-ogygia-region-css>` in the head, not a link.
		for (const m of html.matchAll(INLINE_REGION_STYLE_G)) css += m[1] + '\n';
		// Whole-token match: `hbtoken-d` must not match inside `hbtoken-direct`.
		const has = (tok: string) => new RegExp(`${tok}(?![a-z])`).test(css);
		for (const tok of RENDERED)
			check(`rendered island CSS is linked (${tok})`, has(tok), `sheets: ${sheets.join(', ')}`);
		for (const tok of UNRENDERED)
			check(`unrendered mark CSS is NOT linked (${tok})`, !has(tok), `sheets: ${sheets.join(', ')}`);
		// No duplicate hrefs either (a sheet linked by Kit AND by the region channel).
		check('no stylesheet href linked twice', new Set(sheets).size === sheets.length, sheets.join('\n'));
	});

	test('browser: the rendered islands are styled and wake', async ({ page }) => {
		await page.goto('/head-budget', { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('[data-hb-direct]', { timeout: 8000 }).catch(() => {});
		const outline = (sel: string) =>
			page
				.locator(sel)
				.evaluate((el) => getComputedStyle(el).outlineColor)
				.catch(() => '');
		check('direct island styled', (await outline('[data-hb-direct]')) === 'rgb(9, 176, 84)');
		check('chosen registry block styled', (await outline('[data-hb-block="a"]')) === 'rgb(9, 176, 84)');
		check('only block a rendered from the registry', (await page.locator('[data-hb-block]').count()) === 1);
		// A `wake: 'load'` island does not replay a click made before it hydrates (only `interaction`
		// islands capture one), and the server-rendered button is clickable at once — so wait for the
		// wake, or the click races it (this failed ~2 in 5 on a fast machine, before any change).
		const woke = await page
			.waitForSelector('ogygia-region[data-hydrated] [data-hb-direct]', { timeout: 8000 })
			.then(() => true)
			.catch(() => false);
		check('direct island hydrated', woke);
		await page.locator('[data-hb-direct] button').click();
		await page.waitForTimeout(200);
		check(
			'direct island woke (click counted)',
			(await page.locator('[data-hb-direct] button').innerText()).includes('n 1')
		);
	});
});
