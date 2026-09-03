// Nested-region checks (fetch + Playwright). Usage: pnpm exec playwright test nested
// A region whose own source imports another component `with { wake }`: the inner region
// degrades to a normal component and hydrates ONCE, with its parent.
import { test, check } from './fixtures/index.ts';
import {
	KIT_MARKER_RE,
	REGION_DEFER_G_RE,
	REGION_OPEN_G_RE,
	VITE_CLIENT_RE,
	VITE_FS_RE,
	VITE_ID_RE
} from './fixtures/re.ts';

const OUTER_RE = /data-outer/;
const INNER_CHILD_RE = /inner child/;
const HEY_RE = /Hey, \w+!/;
const NESTED_ISLAND_RE = /nested island/i;
const OGYGIA_RE = /ogygia/;

const count = (s: string, re: RegExp) => (s.match(re) || []).length;
const note = (text: string) => test.info().annotations.push({ type: 'note', description: text });

// The SSR document is fetched once: the fetch checks read it, and the browser leg needs its
// dev/prod sniff (the nested-island warning is dev-only).
let ssr_status = 0;
let ssr_html = '';
let is_dev = false;

test.describe('island-in-island single hydration + dev warn', () => {
	test.beforeAll(async ({ baseURL }) => {
		const res = await fetch(baseURL + '/nested');
		ssr_status = res.status;
		ssr_html = await res.text();
		is_dev =
			VITE_CLIENT_RE.test(ssr_html) || VITE_FS_RE.test(ssr_html) || VITE_ID_RE.test(ssr_html);
	});

	test('SSR: exactly ONE ogygia-region (outer); inner + nested deferred regions degrade inline', () => {
		const html = ssr_html;
		check('/nested returns 200', ssr_status === 200);
		check(
			'/nested emits exactly ONE ogygia-region (outer only; inner degraded)',
			count(html, REGION_OPEN_G_RE) === 1,
			`${count(html, REGION_OPEN_G_RE)}`
		);
		check('/nested outer island SSR content', OUTER_RE.test(html));
		check(
			'/nested inner rendered INLINE in SSR (no inner ogygia-region)',
			INNER_CHILD_RE.test(html)
		);
		// a deferred region nested inside a waking region degrades to an inline normal component
		check(
			'/nested nested deferred region degraded to inline (no render="defer" region)',
			count(html, REGION_DEFER_G_RE) === 0
		);
		check('/nested nested server greeting rendered inline (Hey, ...)', HEY_RE.test(html));
		check('/nested ships NO Kit bootstrap (csr=false)', !KIT_MARKER_RE.test(html));
	});

	test('browser: single hydration — outer, inner, and nested defer+hydrate all interactive', async ({
		page
	}) => {
		const errs: string[] = [];
		const warns: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'warning') warns.push(m.text());
		});
		await page.goto('/nested', { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('[data-outer]', { timeout: 5000 });

		// exactly one ogygia-region in the live DOM, hydrated once; inner never becomes its own island
		check(
			'live DOM has exactly one ogygia-region',
			(await page.locator('ogygia-region').count()) === 1
		);
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 5000 }).catch(() => {});
		check(
			'the outer island hydrated',
			(await page.locator('ogygia-region[data-hydrated]').count()) === 1
		);
		check(
			'no stray nested ogygia-region element',
			(await page.locator('ogygia-region[data-nested]').count()) === 0
		);

		// outer interactive
		await page.click('[data-outer-btn]');
		await page.click('[data-outer-btn]');
		check(
			'outer island is interactive',
			(await page.locator('[data-outer-m]').textContent()) === '2'
		);

		// inner interactive (hydrated with the parent, single hydration)
		await page.locator('[data-inner]').scrollIntoViewIfNeeded();
		await page.click('[data-inner]');
		check(
			'inner (degraded) island is interactive',
			(await page.locator('[data-inner-n]').textContent()) === '1'
		);

		// nested defer+hydrate degrades the same way: inline in SSR, rides parent hydrate
		check(
			'nested defer+hydrate counter present inline (no own region)',
			(await page.locator('[data-nested-defer-hydrate] [data-counter]').count()) === 1
		);
		const dhBtn = page.locator('[data-nested-defer-hydrate] [data-counter] button');
		await dhBtn.click();
		await dhBtn.click();
		check(
			'nested defer+hydrate counter interactive via parent hydrate',
			(await dhBtn.textContent()) === 'count is 2',
			(await dhBtn.textContent()) || ''
		);

		check(
			'no page errors (single hydration, no mismatch)',
			errs.length === 0,
			errs.slice(0, 2).join('; ')
		);

		// dev-only warning naming the nested island
		if (is_dev) {
			const warned = warns.some((w) => NESTED_ISLAND_RE.test(w) && OGYGIA_RE.test(w));
			check(
				'dev warning fired for the nested island',
				warned,
				warns
					.filter((w) => OGYGIA_RE.test(w))
					.slice(0, 1)
					.join('')
			);
		} else {
			check(
				'no nested-island warning in production build',
				!warns.some((w) => NESTED_ISLAND_RE.test(w))
			);
			note('SKIP  dev-warning presence check (prod build)');
		}
	});
});
