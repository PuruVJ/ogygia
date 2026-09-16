// HEAD BUDGET, csr=true — a Kit-hydrated page links only what it RENDERS, and still hydrates it.
//
// REGRESSION (a newsroom route on a customer platform, 2026-09-15): a route that keeps the Kit client
// imported the same 337-mark block registry the csr=false pages use. Kit links a route's stylesheets
// and preloads from the page's STATIC client graph, and the client wrapper of every mark reached its
// component statically, so the page linked 172 stylesheets (base: 55) for 4 rendered islands — the
// csr=false registry stub (head-budget.spec.ts) never applied there because Kit needs the real
// components to hydrate. The fix keeps Kit's inline hydration and makes the client wrapper's
// component LAZY: the server stamps a `<meta name="ogygia-kit-island">` per rendered island, the
// wrapper's component module imports the entry only for stamped islands (top-level await, so Kit
// hydrates with the component in hand), and a wrapper Kit creates on a client-side navigation loads
// its component on demand.
//
// Guards, on the csr=true twin of /head-budget:
//   (1) Kit boots, NO ogygia runtime, NO <ogygia-region> — the csr=true contract is unchanged;
//   (2) every linked stylesheet is grepped: the two rendered islands' tokens present, the five
//       unplaced registry blocks' and the unused mark's absent; a small link budget;
//   (3) one rendered stamp per rendered island, none for the rest;
//   (4) in the browser the rendered islands are styled, hydrated by Kit and interactive;
//   (5) a Kit CLIENT-SIDE navigation to a page rendering a block the first page never did (b)
//       renders it, styled and interactive — the on-demand path — and back again.
// Usage: pnpm exec playwright test head-budget-kit
import { test, check, sleep } from './fixtures/index.ts';
import { KIT_MARKER_RE } from './fixtures/re.ts';

const STYLESHEET_LINK_G = /<link\b[^>]*rel="stylesheet"[^>]*>/g;
const INLINE_REGION_STYLE_G = /<style data-ogygia-region-css="[^"]*">([^<]*)<\/style>/g;
const MODULEPRELOAD_LINK_G = /<link\b[^>]*rel="modulepreload"[^>]*>/g;
const HREF_RE = /href="([^"]+)"/;
const STAMP_G = /<meta name="ogygia-kit-island" content="([^"]+)">/g;
const RUNTIME_SCRIPT_RE = /data-ogygia-runtime/;
const REGION_TAG_RE = /<ogygia-region\b/;
// `hbtoken-direct` is a mark ON the csr=true route host: stripped to a plain import there (ogygia
// steps aside on a csr=true route), so Kit links and hydrates it as its own component.
const RENDERED = ['hbtoken-a', 'hbtoken-direct'];
const UNRENDERED = ['hbtoken-b', 'hbtoken-c', 'hbtoken-d', 'hbtoken-e', 'hbtoken-f'];
// Kit's own route sheets (incl. the plain BlockDirect) plus ONE for the rendered registry block;
// Kit's node preloads plus that block's entry and closure. Five leaked registry sheets trip the
// count; the token greps catch one.
const MAX_STYLESHEETS = 5;
const MAX_MODULEPRELOADS = 40;

test.describe('HEAD BUDGET (csr=true): a Kit page links only what it renders, Kit still hydrates it', () => {
	test('SSR: Kit boots, no runtime, no region tags; stylesheets carry the rendered islands only; one stamp each', async ({
		baseURL
	}) => {
		const res = await fetch(baseURL + '/head-budget-kit');
		const html = await res.text();
		check('/head-budget-kit returns 200', res.status === 200);
		check('csr=true: Kit bootstrap present', KIT_MARKER_RE.test(html));
		check('csr=true: NO ogygia runtime script', !RUNTIME_SCRIPT_RE.test(html));
		check('csr=true: NO <ogygia-region> in the SSR (islands render inline)', !REGION_TAG_RE.test(html));
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
		let css = '';
		for (const href of sheets) {
			const r = await fetch(new URL(href, baseURL).href);
			css += (await r.text()) + '\n';
		}
		// The region-css channel's other shape: a rendered island's sheet under the playground's
		// `kit.inlineStyleThreshold` is a `<style data-ogygia-region-css>` in the head, not a link.
		for (const m of html.matchAll(INLINE_REGION_STYLE_G)) css += m[1] + '\n';
		const has = (tok: string) => new RegExp(`${tok}(?![a-z])`).test(css);
		for (const tok of RENDERED)
			check(`rendered island CSS is linked (${tok})`, has(tok), `sheets: ${sheets.join(', ')}`);
		for (const tok of UNRENDERED)
			check(`unrendered mark CSS is NOT linked (${tok})`, !has(tok), `sheets: ${sheets.join(', ')}`);
		check('no stylesheet href linked twice', new Set(sheets).size === sheets.length, sheets.join('\n'));
		// One stamp: the registry block that rendered (BlockDirect is Kit's plain component here).
		const stamps = [...html.matchAll(STAMP_G)].map((m) => m[1]);
		check(`exactly one rendered stamp (block a), got ${stamps.length}`, stamps.length === 1, stamps.join('\n'));
		check('the stamp names the island entry', /og-region\.[0-9a-f]+\.js$/.test(stamps[0] ?? ''), stamps[0] ?? '');
	});

	test('browser: Kit hydrates the rendered islands (styled, interactive); a client navigation loads block b on demand', async ({
		page
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(String(e)));
		page.on('console', (m) => {
			if (m.type() === 'error' || /hydration|mismatch/i.test(m.text())) errors.push(m.text());
		});
		await page.goto('/head-budget-kit', { waitUntil: 'load' });
		await sleep(500);
		const outline = (sel: string) =>
			page
				.locator(sel)
				.evaluate((el) => getComputedStyle(el).outlineColor)
				.catch(() => '');
		check('direct island styled', (await outline('[data-hb-direct]')) === 'rgb(9, 176, 84)');
		check('chosen registry block a styled', (await outline('[data-hb-block="a"]')) === 'rgb(9, 176, 84)');
		check('only block a rendered from the registry', (await page.locator('[data-hb-block]').count()) === 1);
		await page.locator('[data-hb-direct] button').click();
		await page.locator('[data-hb-block="a"] button').click();
		await sleep(150);
		check('direct island hydrated by Kit (click counted)', (await page.locator('[data-hb-direct] button').innerText()).includes('n 1'));
		check('block a hydrated by Kit (click counted)', (await page.locator('[data-hb-block="a"] button').innerText()).includes('n 1'));
		check(
			'no <ogygia-region> in the live DOM',
			(await page.locator('ogygia-region').count()) === 0
		);
		// ── Kit client-side navigation: block b was never rendered by the server ──
		await page.locator('[data-to-b]').click();
		await page.waitForSelector('[data-hb-block="b"] button', { timeout: 8000 }).catch(() => {});
		check('after client navigation: block b rendered (loaded on demand)', (await page.locator('[data-hb-block="b"]').count()) === 1);
		check('block b styled', (await outline('[data-hb-block="b"]')) === 'rgb(9, 176, 84)');
		await page.locator('[data-hb-block="b"] button').click();
		await sleep(150);
		check('block b interactive', (await page.locator('[data-hb-block="b"] button').innerText()).includes('n 1'));
		check('document still a Kit page (no full reload markers lost)', (await page.evaluate(() => location.pathname)) === '/head-budget-kit/b');
		// ── and back ──
		await page.locator('[data-to-a]').click();
		await page.waitForSelector('[data-hb-block="a"] button', { timeout: 8000 }).catch(() => {});
		check('back: block a rendered again', (await page.locator('[data-hb-block="a"]').count()) === 1);
		await page.locator('[data-hb-block="a"] button').click();
		await sleep(150);
		check('back: block a interactive', (await page.locator('[data-hb-block="a"] button').innerText()).includes('n 1'));
		check('no page errors / hydration mismatches', errors.length === 0, errors.slice(0, 3).join(' | '));
	});
});
