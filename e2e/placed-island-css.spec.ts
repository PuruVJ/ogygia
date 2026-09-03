// REGRESSION: a PLACED client island's own CSS must load on the page it renders on.
//
// Kit links a route's STATIC import graph, but Rollup can chunk-split a `wake`-marked component's
// CSS — notably its `:global()` rules (a Bits UI dropdown trigger/menu, a scoped card) — into a
// chunk the page never loads, so the island renders browser-default in a production build. The
// design assumed a plain island's CSS was "already in the page's own stylesheet"; chunk-splitting
// violates that. Region.svelte now ships each placed island's own CSS as `<link
// data-ogygia-region-css>` (the same channel a held dual uses, deduped per-request).
//
// Two guards: (1) the placed island EMITS its CSS link (the fix's mechanism — deterministic
// regardless of whether the CSS happened to split), and (2) the `:global()` style actually applies.
//
// Usage: pnpm exec playwright test placed-island-css
import { test, check } from './fixtures/index.ts';
import { KIT_MARKER_RE, REGION_CSS_LINK_RE } from './fixtures/re.ts';

const REGION_OPEN_RE = /<ogygia-region\b/;
/** The whole hoisted `<link data-ogygia-region-css …>` tag (the shared RE is the attribute alone). */
const REGION_CSS_LINK_TAG_RE = /<link\b[^>]*data-ogygia-region-css[^>]*>/;
const CSS_HREF_RE = /href="[^"]+\.css"/;

test.describe('REGRESSION: placed client island ships its own CSS (chunk-split :global)', () => {
	// ---------------------------------------------------------------- fetch/SSR --
	test('SSR: the placed island emits its own CSS as <link data-ogygia-region-css>', async ({
		baseURL
	}) => {
		const res = await fetch(baseURL + '/placed-island-css');
		const html = await res.text();
		check('/placed-island-css returns 200', res.status === 200);
		check('/placed-island-css ships NO Kit bootstrap (csr=false)', !KIT_MARKER_RE.test(html));
		check('/placed-island-css SSR has the placed island region', REGION_OPEN_RE.test(html));
		// THE FIX: the placed island's own CSS ships as a hoisted region-css link → a real `.css` in a
		// production build. Absent before the fix (region_css_html only fired for held duals).
		const link = html.match(REGION_CSS_LINK_TAG_RE)?.[0] || '';
		check(
			'placed island emits its own CSS as <link data-ogygia-region-css>',
			REGION_CSS_LINK_RE.test(link) && CSS_HREF_RE.test(link),
			link || 'no region-css link in SSR'
		);
	});

	// ---------------------------------------------------------------- browser ----
	test("browser: the island's :global() CSS is loaded and applied", async ({ page }) => {
		await page.goto('/placed-island-css', { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('[data-css-probe]', { timeout: 8000 }).catch(() => {});
		// The distinctive outline colour proves the island's `:global()` CSS is present (unstyled → the
		// browser default `rgb(0, 0, 0)` / transparent, never this rgb).
		const outline = await page
			.locator('[data-css-probe]')
			.evaluate((el) => getComputedStyle(el).outlineColor)
			.catch(() => '');
		check(
			'placed island: its :global() CSS loaded and applied',
			outline === 'rgb(9, 176, 84)',
			outline
		);
	});
});
