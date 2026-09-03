// FOREIGN-MUTATION DETECTOR (internal/notes/foreign-dom.md, from the se.com/QDS incident):
// when something rewrites a region's HTML between SSR and wake (a post-SSR transformPageChunk,
// a DSD-injecting middleware, an A/B tool), Svelte's hydration silently discards the server DOM
// and re-renders — destroying whatever the rewriter injected, while ogygia used to report plain
// success. The runtime now flags exactly that: `data-og-recovered` + an attributing console.warn.
//
// Fixture: /detector renders two wake:'load' islands; the playground hooks corrupt ONLY the
// first one's region HTML (strip its `<!--[-->` anchors — what Stencil's renderToString did on
// se.com). Asserts: the corrupted island is flagged AND still interactive (recovery re-rendered
// it); the healthy sibling is NOT flagged; a normal page has no flags at all.
//
// Usage: pnpm exec playwright test detector
import { test, check } from './fixtures/index.ts';

test.describe('foreign-mutation detector: corrupted region → data-og-recovered + warn; healthy pages clean', () => {
	// ── corrupted page ────────────────────────────────────────────────────────────────────────────
	test('corrupted island is flagged, attributed, and still interactive; healthy sibling is not', async ({
		page
	}) => {
		const warns: string[] = [];
		page.on('console', (m) => m.type() === 'warning' && warns.push(m.text()));

		await page.goto('/detector', { waitUntil: 'networkidle' });
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 8000 });
		// let both islands finish waking before sampling attributes
		await page
			.waitForFunction(
				() => document.querySelectorAll('ogygia-region[data-hydrated]').length >= 2,
				{
					timeout: 8000
				}
			)
			.catch(() => {});

		const flags = await page.evaluate(() => {
			const all = [...document.querySelectorAll('ogygia-region')];
			const of = (el: Element | null) =>
				el ? !!el.closest('ogygia-region')?.hasAttribute('data-og-recovered') : null;
			return {
				regions: all.length,
				recovered_total: all.filter((r) => r.hasAttribute('data-og-recovered')).length,
				broken_flagged: of(document.querySelector('[data-testid="broken-root"]')),
				healthy_flagged: of(document.querySelector('[data-testid="healthy-root"]'))
			};
		});
		check('corrupted island is flagged data-og-recovered', flags.broken_flagged === true);
		check('healthy sibling is NOT flagged', flags.healthy_flagged === false);
		check(
			'exactly one region flagged on the page',
			flags.recovered_total === 1,
			`got ${flags.recovered_total}`
		);

		const attributed = warns.find((w) => w.includes('discarded its ENTIRE server-rendered DOM'));
		check('attributing console.warn fired', !!attributed);
		check(
			'warn names the likely causes + the lake fix',
			!!attributed &&
				attributed.includes('post-SSR transform') &&
				attributed.includes("wake:'none'")
		);

		// recovery means the island was re-rendered client-side — it must still WORK
		await page.click('[data-testid="broken-btn"]');
		const btn = await page.textContent('[data-testid="broken-btn"]');
		check(
			'recovered island is still interactive',
			btn?.trim() === 'clicked 1',
			`got "${btn?.trim()}"`
		);
	});

	// ── negative control: a normal page must not flag ─────────────────────────────────────────────
	test('negative control: a healthy page has no data-og-recovered flags', async ({ page }) => {
		await page.goto('/', { waitUntil: 'networkidle' });
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 8000 }).catch(() => {});
		const clean_flags = await page.evaluate(
			() => document.querySelectorAll('ogygia-region[data-og-recovered]').length
		);
		check('no false positives on a healthy page', clean_flags === 0, `got ${clean_flags}`);
	});
});
