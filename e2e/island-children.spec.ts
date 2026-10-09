// Cross-island composition: a host page composes a hydrate island from the OUTSIDE — default
// children, a captured host value, a named snippet, a parameterized snippet, and a NESTED ISLAND —
// and the compiler ships them all as a synthesized entry. Everything must render on SSR, survive
// the csr=false hydrate (no wipe / mismatch), and stay interactive (parent toggle + nested island).
// Usage: pnpm exec playwright test island-children
import { test, check } from './fixtures/index.ts';
import { BUMPER_5_RE } from './fixtures/re.ts';

const REGION_ENTRY_RE = /ogygia-region entry="/g;
const CHILD_HEADER_RE = /data-child-header[^>]*>header for Ada/;
const CHILD_STATIC_RE = /data-child-static[^>]*>hello Ada/;
const CHILD_ROW_RE = /data-child-row[^>]*>(one|two) · Ada/g;

test.describe('host children/snippets cross into a hydrate island (synth entry)', () => {
	test('SSR', async ({ baseURL }) => {
		const raw = await (await fetch(baseURL + '/island-children')).text();
		// Two CardShell call sites → two regions; the nested Bumper degrades inline (would be 3 otherwise).
		check(
			'SSR: one region per call site + the nested island as its OWN region (slot crossing)',
			(raw.match(REGION_ENTRY_RE) || []).length === 3,
			`regions=${(raw.match(REGION_ENTRY_RE) || []).length}`
		);
		check('SSR: captured value in named snippet', CHILD_HEADER_RE.test(raw));
		check('SSR: default children with captured value', CHILD_STATIC_RE.test(raw));
		check(
			'SSR: parameterized snippet rendered by the island',
			(raw.match(CHILD_ROW_RE) || []).length === 2
		);
		check('SSR: nested island seeded (bumper=5)', BUMPER_5_RE.test(raw));
	});

	test('Browser', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push('console: ' + m.text());
		});
		await page.goto('/island-children', { waitUntil: 'networkidle' });
		await page.waitForTimeout(250);

		check(
			'children survive hydration (not wiped)',
			(await page.locator('[data-child-static]').innerText()) === 'hello Ada'
		);
		check(
			'named snippet survives hydration',
			(await page.locator('[data-child-header]').innerText()) === 'header for Ada'
		);
		check(
			'param snippet survives hydration',
			(await page.locator('[data-child-row]').count()) === 2
		);

		// Nested island B is interactive (degraded → hydrated with A)
		check('nested island seed', (await page.locator('[data-bumper-n]').innerText()) === '5');
		await page.locator('[data-bumper]').click();
		await page.waitForTimeout(50);
		check(
			'nested island B is live (5 → 6)',
			(await page.locator('[data-bumper-n]').innerText()) === '6',
			`n=${await page.locator('[data-bumper-n]').innerText()}`
		);

		// Parent island A is live and gates the crossed children
		await page.locator('[data-card-toggle]').first().click();
		await page.waitForTimeout(50);
		check(
			'parent island A live: toggle hides crossed children',
			(await page.locator('[data-child-static]').count()) === 0
		);
		await page.locator('[data-card-toggle]').first().click();
		await page.waitForTimeout(50);
		check(
			'parent island A live: toggle restores crossed children',
			(await page.locator('[data-child-static]').count()) === 1
		);

		// Per-call-site: a SECOND usage of the same import with different children is its own island.
		check(
			'second call site of the same import renders its own children',
			(await page.locator('[data-child-second]').innerText()) === 'second card, Ada'
		);

		check('no page errors / hydration mismatch', errors.length === 0, errors.join(' | '));
	});
});
