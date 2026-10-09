// SEED REFERENCES — island props that point into the page seed instead of copying it.
//
// REPRODUCTION (a field brand page, 2026-09-09): a CMS load returns one content tree; every block
// island gets its slice of that tree as props; one island reads `$page`, so the seed ships. The
// same JSON crossed twice — 674 KB of seed + 481 KB of props, 94% of them verbatim seed subtrees —
// and was serialized twice on the server (the larger part of the page's TTFB gap to plain Kit).
//
// `/seed-refs` is that shape: 12 block islands fed from `data.catalog` (even ones by identity, odd
// ones through a JSON clone, the way a CMS SDK hands data out) plus one `$page` reader.
// `/seed-refs/noseed` is the twin without a reader: no seed, so props must stay full copies.
//
// Guards: (1) SSR bytes — every block's props is a reference on the seeded page, none on the twin,
// and the seeded page's props total is a small fraction of the seed; (2) hydration — each island
// renders its block from the reference and its click works; (3) SPA navigation between the twins
// both ways keeps hydrating (a fetched document's references resolve against THAT document's seed).
// Usage: pnpm exec playwright test seed-refs
import { test, check } from './fixtures/index.ts';
import { KIT_MARKER_RE } from './fixtures/re.ts';

const SIDECAR_G = /<script type="application\/ogygia-props"[^>]*>([\s\S]*?)<\/script>/g;
const SEED_RE = /<script type="application\/ogygia-page"[^>]*>([\s\S]*?)<\/script>/;
const REF = 'OgygiaSeedRef';

test.describe('SEED REFERENCES: props point into the seed instead of copying it', () => {
	test('SSR: seeded page → references; no-seed twin → full copies', async ({ baseURL }) => {
		const seeded = await (await fetch(baseURL + '/seed-refs')).text();
		const twin = await (await fetch(baseURL + '/seed-refs/noseed')).text();
		check('seeded page is csr=false', !KIT_MARKER_RE.test(seeded));

		const sidecars = [...seeded.matchAll(SIDECAR_G)].map((m) => m[1]);
		const seed = seeded.match(SEED_RE)?.[1] ?? '';
		check('seeded page ships the seed (a $page reader is on it)', seed.length > 0);
		check('seeded page has 13 sidecars (12 blocks + the reader)', sidecars.length === 13, String(sidecars.length));
		const blocks = sidecars.filter((s) => s.includes('block-'));
		const refs = sidecars.filter((s) => s.includes(REF));
		check('every block sidecar is a reference (identity AND clone)', refs.length === 12, `${refs.length} refs`);
		check('no block sidecar carries the block body any more', blocks.length === 0, `${blocks.length} still carry copies`);
		const props_bytes = sidecars.reduce((s, t) => s + t.length, 0);
		check(
			`props total is under 10% of the seed (${props_bytes} vs ${seed.length})`,
			props_bytes < seed.length / 10
		);

		const twin_sidecars = [...twin.matchAll(SIDECAR_G)].map((m) => m[1]);
		check('twin ships NO seed', !SEED_RE.test(twin));
		check('twin has 12 sidecars', twin_sidecars.length === 12, String(twin_sidecars.length));
		check('twin sidecars are full copies (no references)', twin_sidecars.every((s) => !s.includes(REF)));
		check('twin sidecars carry the block bodies', twin_sidecars.every((s) => s.includes('Lorem ipsum')));
	});

	test('browser: islands hydrate from references, click, and survive SPA nav both ways', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'warning' && m.text().includes('[ogygia]')) errors.push(m.text());
		});
		await page.goto('/seed-refs', { waitUntil: 'networkidle' });
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 8000 }).catch(() => {});
		check('13 islands hydrated', (await page.locator('ogygia-region[data-hydrated]').count()) === 13);
		check('reader shows page.data', (await page.locator('[data-page-greeting]').innerText()) === 'hello from page.data');
		check('12 blocks rendered', (await page.locator('[data-block]').count()) === 12);
		// a block from an identity reference and one from a clone reference, both with their data
		const b0 = page.locator('[data-block="block-0"]');
		const b1 = page.locator('[data-block="block-1"]');
		check('block-0 (identity) has its title', (await b0.locator('[data-block-title]').innerText()).startsWith('Block 0'));
		check('block-1 (clone) has its title', (await b1.locator('[data-block-title]').innerText()).startsWith('Block 1'));
		check('block-1 has its links from the referenced data', (await b1.locator('a').count()) === 2);
		await b1.locator('[data-block-btn]').click();
		await page.waitForTimeout(100);
		check('block-1 hydrated and counts (weight 1 + 1)', (await b1.locator('[data-block-btn]').innerText()) === '1 + 1');
		check('no errors or ogygia warnings', errors.length === 0, errors.join(' | '));

		// SPA nav to the no-seed twin (full copies) and back (references again)
		await page.locator('[data-to-noseed]').click();
		await page.waitForFunction(() => location.pathname.endsWith('/seed-refs/noseed'), null, { timeout: 8000 });
		await page.waitForTimeout(300);
		check('twin: 12 blocks after nav', (await page.locator('[data-block]').count()) === 12);
		await page.locator('[data-block="block-2"] [data-block-btn]').click();
		await page.waitForTimeout(100);
		check('twin: block-2 hydrated (2 + 1)', (await page.locator('[data-block="block-2"] [data-block-btn]').innerText()) === '2 + 1');
		await page.locator('[data-to-seed]').click();
		await page.waitForFunction(() => /\/seed-refs\/?$/.test(location.pathname), null, { timeout: 8000 });
		await page.waitForTimeout(300);
		check('back: reader shows page.data', (await page.locator('[data-page-greeting]').innerText()) === 'hello from page.data');
		const b3 = page.locator('[data-block="block-3"]');
		check('back: block-3 (clone ref) rendered from the NEW document\'s seed', (await b3.locator('[data-block-title]').innerText()).startsWith('Block 3'));
		await b3.locator('[data-block-btn]').click();
		await page.waitForTimeout(100);
		check('back: block-3 hydrated (3 + 1)', (await b3.locator('[data-block-btn]').innerText()) === '3 + 1');
		check('no errors across the round trip', errors.length === 0, errors.join(' | '));
	});
});
