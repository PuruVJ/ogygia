// INLINE REGION CSS. Kit's `inlineStyleThreshold` is the one number for inline-vs-link CSS; ogygia's
// region-CSS channel obeys it: a region sheet under the threshold ships as
// `<style data-ogygia-region-css="href">` (no render-blocking request), one over it stays a
// `<link>`. A measured home page carried twenty-five island sheets, 42 KB, twenty under 3 KB — each
// a request before first paint. Both shapes share the identity (the href), so the runtime hoists an
// inlined sheet from a hole answer into <head> and dedupes it, and the router keeps it across swaps.
// The playground sets the threshold to 400: the two tiny sheets here inline; LinkedCssIsland is the
// CONTROL — identical rules, sheet padded over the threshold, linked — so the same page carries both
// shapes and their computed styles must match (with or without the threshold, the styling is the
// same). Region sheets are named by hashed ids, so every assertion keys on the CSS TEXT.
//
//   pnpm exec playwright test inline-css
import { test, check, sleep } from './fixtures/index.ts';

const INLINE_STYLE_G = /<style data-ogygia-region-css="([^"]*)">([^<]*)<\/style>/g;
const REGION_LINK_G = /<link\b[^>]*href="([^"]+)"[^>]*data-ogygia-region-css[^>]*>/g;
const PROPS = ['letterSpacing', 'borderTopWidth', 'borderTopStyle', 'borderTopColor'] as const;

test.describe('inline region css under Kit’s inlineStyleThreshold', () => {
	test('SSR: the tiny sheet is a <style> keyed by its href in <head>; the padded control stays a <link>', async ({ baseURL }) => {
		// Kit serves the page at `/inline-css` (trailing slash redirected away); the head's relative
		// asset hrefs (`./_app/…`) resolve against THAT url, the way the browser does.
		const res = await fetch(baseURL + '/inline-css');
		const html = await res.text();
		const head = html.slice(0, html.indexOf('</head>'));
		const inlined = [...head.matchAll(INLINE_STYLE_G)].map((m) => ({ href: m[1], css: m[2] }));
		const links = [...html.matchAll(REGION_LINK_G)].map((m) => m[1]);
		const linked_css: string[] = [];
		for (const href of links) linked_css.push(await (await fetch(new URL(href, res.url).href)).text());
		check('tiny island sheet inlined as <style data-ogygia-region-css="…"> in <head>', inlined.some((s) => s.css.includes('.inline-css') && s.href.endsWith('.css')), JSON.stringify(inlined.map((s) => s.href)));
		check('the tiny island sheet is NOT also linked', !linked_css.some((c) => c.includes('.inline-css{') || c.includes('.inline-css.')), links.join(','));
		check('control island (over the threshold) still links its sheet', linked_css.some((c) => c.includes('.linked-css')), links.join(','));
		check('control island is NOT inlined', !inlined.some((s) => s.css.includes('.linked-css')));
		check('every inlined sheet has a non-empty identity', inlined.every((s) => s.href.length > 0));
	});

	test('browser: inlined and linked islands compute the same styles; the hole answer’s inlined sheet is hoisted and applied', async ({ page }) => {
		const errs: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		await page.goto('/inline-css/', { waitUntil: 'networkidle' });
		await sleep(300);
		const inline = page.locator('[data-inline-css]');
		const linked = page.locator('[data-linked-css]');
		const styles = (sel: string) => page.locator(sel).evaluate((el, props) => { const cs = getComputedStyle(el); return Object.fromEntries(props.map((p) => [p, cs[p as keyof CSSStyleDeclaration]])); }, PROPS as unknown as string[]);
		const a = await styles('[data-inline-css]');
		const b = await styles('[data-linked-css]');
		check('inlined island styled (letter-spacing 3px)', a.letterSpacing === '3px', JSON.stringify(a));
		check('WITH vs WITHOUT the threshold: identical computed styles for identical rules', JSON.stringify(a) === JSON.stringify(b), JSON.stringify({ a, b }));
		await inline.click();
		await linked.click();
		check('both islands interactive', (await inline.textContent())!.includes('inline:1') && (await linked.textContent())!.includes('linked:1'));

		await page.waitForSelector('[data-inline-css-hole]', { timeout: 10_000 });
		check('hole fallback gone', (await page.locator('[data-inline-css-fallback]').count()) === 0);
		const hole = page.locator('[data-inline-css-hole]');
		check('hole content styled from its hoisted inline sheet (word-spacing 5px)', (await hole.evaluate((el) => getComputedStyle(el).wordSpacing)) === '5px');
		const heads = await page.evaluate(() => [...document.head.querySelectorAll('style[data-ogygia-region-css]')].map((s) => ({ id: s.getAttribute('data-ogygia-region-css') || '', css: s.textContent || '' })));
		check('hole sheet hoisted into <head> as an inline style', heads.some((h) => h.css.includes('.inline-css-hole')), heads.map((h) => h.id).join(','));
		check('no sheet inlined twice', new Set(heads.map((h) => h.id)).size === heads.length, heads.map((h) => h.id).join(','));
		check('no inline style left in the body', (await page.locator('body style[data-ogygia-region-css]').count()) === 0);
		check('no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
	});
});
