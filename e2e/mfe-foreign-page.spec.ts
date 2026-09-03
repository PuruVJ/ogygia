// FOREIGN PAGE READ (fragment federation, dev warning) — end to end, in a real browser.
//
// A mounted MFE island that reads `page.data` (the `$app/state` shim; `$app/stores` rides the same
// path) hydrates inside the SHELL's document. There the shim answers with the shell's page — one
// singleton per document — not the MFE's, whose own page seed sits in its `<head>` and never crosses
// the fragment boundary. So the island's SSR HTML (rendered by the MFE) and its hydrated self
// disagree. ogygia warns once per island in dev, naming the field, the island entry, and the MFE
// origin. On the MFE's OWN front door the same island is local: no warning, and the value survives.
//
// Servers: the `mfe` worker fixture (three `vite dev` servers from examples/mfe, throwaway keys).
import { test, expect } from './fixtures/mfe.ts';
import { FOREIGN_WARN_RE } from './fixtures/re.ts';

/** The cms SERVER render of the probe reads the cms page (`site` from the cms layout load) —
 *  Kit's server `$app/state` answers under the ogygia router because the document sets Kit's
 *  request context. Mounted in the shell that HTML is spliced as-is; the repaint to ∅ is the
 *  hydrated island reading the shell's page. */
const SSR_PROBE_RE = /data-testid="page-data-probe"[^>]*>page\.data\.site = ACME CMS</;
const HYDRATED_PROBE = 'ogygia-region[data-hydrated] [data-testid="page-data-probe"]';
const HYDRATE_TIMEOUT = 60_000;
/** The island entry inside a warning: `… mounted MFE island (<entry>, from <origin>)`. */
const ENTRY_RE = /mounted MFE island \(([^,]+), from /;
/** The probe's hydrated readout: the shell page has no `site` (∅) / the cms page has one. */
const PROBE_EMPTY_RE = /∅/;
const PROBE_ACME_RE = /ACME CMS/;

test.describe('page reads inside a mounted MFE island', () => {
	// WARM-UP: the worker fixture waits for the three dev servers to answer SSR, but the first
	// BROWSER load still triggers Vite's client dep optimization (and its "outdated optimize dep"
	// reload + console errors). In the long serial run that first load is slow enough to flake the
	// hydrate wait and dirty the console-error assertion. One throwaway visit per page absorbs it.
	test.beforeAll(async ({ browser, mfe }) => {
		for (const url of [mfe.origin('shell') + '/cms/', mfe.origin('cms') + '/cms/']) {
			const p = await browser.newPage();
			await p.goto(url, { waitUntil: 'domcontentloaded' });
			await p
				.locator(HYDRATED_PROBE)
				.waitFor({ timeout: 120_000 })
				.catch(() => {});
			await p.close();
		}
	});

	test('the cms-rendered probe island is spliced into the shell document', async ({ mfe }) => {
		const html = await (await fetch(mfe.origin('shell') + '/cms/')).text();
		expect(
			html,
			'the shell splices the cms fragment body (probe rendered server-side by cms)'
		).toMatch(SSR_PROBE_RE);
	});

	test('mounted in the shell: one warning per island, and the island repaints with the shell page', async ({
		page,
		mfe
	}) => {
		const warnings: string[] = [];
		const errors: string[] = [];
		page.on('console', (m) => {
			if (m.type() === 'warning') warnings.push(m.text());
			if (m.type() === 'error') errors.push(m.text());
		});
		page.on('pageerror', (e) => errors.push(e.message));

		await page.goto(mfe.origin('shell') + '/cms/');
		await expect(
			page.locator(HYDRATED_PROBE),
			'the cms probe island hydrated (foreign delegate path)'
		).toBeVisible({ timeout: HYDRATE_TIMEOUT });
		// The probe's own warning: ONCE. Other mounted islands on the page (a stitched dash widget that
		// reads `page` too) may warn for THEIR entry — that is once-per-island working as designed.
		const probe_warnings = () =>
			warnings.filter(
				(w) =>
					FOREIGN_WARN_RE.test(w) &&
					w.includes('page.data was read') &&
					w.includes(`from ${mfe.origin('cms')}`)
			);
		await expect
			.poll(() => probe_warnings().length, { message: 'the cms probe warned' })
			.toBeGreaterThanOrEqual(1);
		await page.waitForTimeout(500);
		expect(probe_warnings(), 'exactly ONE warning for the probe island').toHaveLength(1);
		const foreign = warnings.filter((w) => FOREIGN_WARN_RE.test(w));
		const entries = foreign.map((w) => w.match(ENTRY_RE)?.[1] ?? w);
		expect(
			new Set(entries).size,
			`one warning per island entry — got:\n${foreign.join('\n')}`
		).toBe(foreign.length);

		const [warning] = probe_warnings();
		expect(warning, 'names the field').toContain('page.data was read');
		expect(warning, 'names the MFE origin').toContain(`from ${mfe.origin('cms')}`);
		expect(warning, 'says whose page this is').toContain("SHELL's page");

		await expect(
			page.getByTestId('page-data-probe'),
			'after hydrate the island reads the shell page (no `site`)'
		).toHaveText(PROBE_EMPTY_RE);
		expect(errors, 'no page errors').toEqual([]);
	});

	test('on the cms front door the same island is local: silent, and the value survives hydrate', async ({
		page,
		mfe
	}) => {
		const warnings: string[] = [];
		page.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()));

		await page.goto(mfe.origin('cms') + '/cms/');
		await expect(page.locator(HYDRATED_PROBE), 'the probe island hydrated').toBeVisible({
			timeout: HYDRATE_TIMEOUT
		});
		await expect(page.getByTestId('page-data-probe')).toHaveText(PROBE_ACME_RE);
		expect(
			warnings.filter((w) => FOREIGN_WARN_RE.test(w)),
			'no foreign page-read warning for a local island'
		).toEqual([]);
	});
});
