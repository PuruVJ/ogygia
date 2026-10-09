// SNIPPETS RENDER IN PLACE (src/portable-form.ts, region-snippet.ts `og_portable`, the compiler's
// portable lowering). A zero-arg `{#snippet}` handed to a PLAIN component is branded, because the
// component might forward it into an island. It used to be REPLACED by its portable form everywhere,
// so even rendered in the same tree it ran as an isolated app: no host context (a CMS block renderer
// in a tab rendered nothing), no host scope class, and an island inside it wrote its own adjacent props
// script (duplicate `og-props-<fp>` ids when rendered twice). Now it runs in place, and only a crossing
// swaps the portable form in.
// Usage: pnpm exec playwright test snippet-in-place
import { test, check } from './fixtures/index.ts';

const ID_ATTR_G = /id="(og-props-[0-9a-f]+)"/g;

test.describe('a branded snippet rendered in the same tree runs in place', () => {
	test('SSR: the host’s context and scoped CSS reach the snippet body (page host and island host)', async ({ request }) => {
		const html = await (await request.get('/snippet-in-place')).text();
		check('page host: the snippet read the page’s context', html.includes('<span data-ctx-read="">from-page</span>'), html.slice(0, 0));
		check('island host: the snippet read the island’s context', html.includes('<span data-ctx-read="">from-island</span>'));
		check('no snippet rendered empty or without its context', !html.includes('MISSING'));
		check('rendered in place: no isolated <ogygia-snippet> wrapper', !html.includes('<ogygia-snippet'));
	});

	test('browser: the same after the island hydrates, and the host’s scoped CSS applies', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto('/snippet-in-place', { waitUntil: 'networkidle' });
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 10_000 });
		await page.locator('[data-in-place-btn]').click();
		check('the island is live', (await page.locator('[data-in-place-btn]').innerText()).includes('1'));
		const reads = await page.locator('[data-ctx-read]').allInnerTexts();
		check('both snippets show their host’s context after hydration', reads.join(',') === 'from-page,from-island', reads.join(','));
		const color = (sel: string) => page.locator(sel).evaluate((el) => getComputedStyle(el).color);
		check('page host’s scoped CSS styles the snippet', (await color('[data-probe="page"]')) === 'rgb(1, 2, 3)', await color('[data-probe="page"]'));
		check('island host’s scoped CSS styles the snippet', (await color('[data-probe="island"]')) === 'rgb(10, 20, 30)', await color('[data-probe="island"]'));
		check('no page errors', errors.length === 0, errors.join(' | '));
	});

	test('a page that renders a snippet (with an island inside) in two places has unique props ids', async ({ request }) => {
		const html = await (await request.get('/portable-snippet')).text();
		const ids = [...html.matchAll(ID_ATTR_G)].map((m) => m[1]);
		const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
		check('no duplicate og-props ids', ids.length > 0 && dup.length === 0, `ids ${ids.join(',')} dup ${dup.join(',')}`);
	});
});
