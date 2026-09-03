// REGRESSION: a content BODY (`.svx`/`.md`) carries its own scoped `<style>`, but the leak-free
// corpus is server-only — its CSS compiles into the SERVER bundle and joins NO page's static
// stylesheet. So on a csr=false doc page the body would render browser-default. ogygia extracts that
// scoped CSS (svelte-compiled from the post-mdsvex source, so `:global` is resolved and the scoped
// hash matches the SSR'd HTML), emits it as a client asset keyed by content_css_key, and Region.svelte
// links it as `<link data-ogygia-region-css>` — the same channel a held dual uses, deduped per-request.
//
// Two guards: (1) the body EMITS its own CSS link (an `og-content.*.css`, the fix's mechanism), and
// (2) the scoped `<style>` actually applies (a distinctive outline, never a browser default).
//
// Usage: pnpm exec playwright test content-css
import { test, check } from './fixtures/index.ts';
import { REGION_CSS_LINK_RE } from './fixtures/re.ts';

const CONTENT_CSS_PROBE_RE = /data-content-css-probe/;
const SCOPED_PROBE_RE = /cssprobe svelte-[a-z0-9]+/;
const REGION_CSS_THEN_CONTENT_RE = /<link\b[^>]*data-ogygia-region-css[^>]*og-content[^>]*>/;
const CONTENT_THEN_REGION_CSS_RE = /<link\b[^>]*og-content[^>]*data-ogygia-region-css[^>]*>/;
const CONTENT_CSS_HREF_RE = /href="[^"]+og-content[^"]+\.css"/;

test.describe('REGRESSION: content body (.svx) ships + applies its own scoped CSS (server-only corpus)', () => {
	// ---------------------------------------------------------------- fetch/SSR --
	test('SSR: the content body emits its own CSS as <link data-ogygia-region-css> (og-content.*.css)', async ({
		baseURL
	}) => {
		const res = await fetch(baseURL + '/content-css');
		const html = await res.text();
		check('/content-css returns 200', res.status === 200);
		check('/content-css SSR renders the content body', CONTENT_CSS_PROBE_RE.test(html));
		// The body's own scoped class is present (svelte-compiled), proving the corpus rendered server-side.
		check('content body is scoped (svelte-<hash>)', SCOPED_PROBE_RE.test(html));
		// THE FIX: the body's own scoped CSS ships as a hoisted region-css link → a real `og-content.*.css`
		// asset. Absent before the fix (the corpus CSS never left the server bundle).
		const link =
			html.match(REGION_CSS_THEN_CONTENT_RE)?.[0] ||
			html.match(CONTENT_THEN_REGION_CSS_RE)?.[0] ||
			'';
		check(
			'content body emits its own CSS as <link data-ogygia-region-css> (og-content.*.css)',
			REGION_CSS_LINK_RE.test(link) && CONTENT_CSS_HREF_RE.test(link),
			link || 'no content-css link in SSR'
		);
	});

	// ---------------------------------------------------------------- browser ----
	test("browser: the body's scoped <style> is loaded and applied", async ({ page }) => {
		await page.goto('/content-css', { waitUntil: 'networkidle' });
		await page.waitForSelector('[data-content-css-probe]', { timeout: 8000 }).catch(() => {});
		// The distinctive outline colour proves the body's scoped `<style>` is present (unstyled → the
		// browser default, never this rgb).
		const outline = await page
			.locator('[data-content-css-probe]')
			.evaluate((el) => getComputedStyle(el).outlineColor)
			.catch(() => '');
		check(
			'content body: its scoped <style> loaded and applied',
			outline === 'rgb(11, 197, 141)',
			outline
		);
	});
});
