// Portable snippets — "a snippet is a region". The page hands a named `{#snippet}` to a PLAIN
// (non-island) shell, which forwards it into a hydrate island. A snippet can't cross an island
// boundary as a function, so the compiler compiles its body into a standalone island ENTRY and
// rewrites the value into `og_portable(Entry, captures, url)`. The crossed copy must: render on SSR
// inside the island (captured host value baked in), survive the csr=false hydrate, and come ALIVE —
// the nested island inside the crossed snippet clicks 5 → 6.
// Usage: pnpm exec playwright test portable-snippet
import { test, check } from './fixtures/index.ts';
import { BUMPER_5_RE, PORTABLE_BAR_RE } from './fixtures/re.ts';

const OGYGIA_REF_RE = /\["OgygiaRef"/;
const SNIPPET_KIND_RE = /"snippet"/;
const OGYGIA_SNIPPET_RE = /ogygia-snippet/;
const GH_ADA_RE = /GitHub · Ada/;
const MODULEPRELOAD_RE = /rel="modulepreload"[^>]*og-region/;

test.describe('a snippet forwarded THROUGH a plain shell into an island crosses + comes alive', () => {
	test('SSR', async ({ baseURL }) => {
		const raw = await (await fetch(baseURL + '/portable-snippet')).text();
		// The snippet crossed into the island as a hub ref of kind 'snippet' (not a serialized function).
		check(
			'SSR: snippet crosses as a portable snippet ref',
			OGYGIA_REF_RE.test(raw) && SNIPPET_KIND_RE.test(raw)
		);
		// It rendered inside the island's <ogygia-region>, wrapped in the portable container, with the
		// captured host value (who = Ada) baked in. Unbounded window: the crossed snippet's nested island
		// is now a REAL `<ogygia-region>` (marks survive into the synth entry) + its props script, so the
		// bar spans far more than the old 400-char cap.
		const barMatch = raw.match(PORTABLE_BAR_RE);
		const bar = barMatch ? barMatch[0] : '';
		check('SSR: crossed snippet rendered inside the island bar', OGYGIA_SNIPPET_RE.test(bar));
		check(
			'SSR: captured host value crossed (GitHub · Ada)',
			GH_ADA_RE.test(bar),
			bar.slice(0, 120)
		);
		check('SSR: nested island inside the crossed snippet seeded (5)', BUMPER_5_RE.test(bar));
		// No-waterfall: the portable entry is preloaded in <head>, fetched in parallel with the host island.
		check('SSR: portable entry preloaded (no waterfall)', MODULEPRELOAD_RE.test(raw));
	});

	test('Browser', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push('console: ' + m.text());
		});
		await page.goto('/portable-snippet', { waitUntil: 'networkidle' });
		await page.waitForTimeout(250);

		const barGh = page.locator('[data-portable-bar] [data-gh]');
		check(
			'crossed snippet survives hydration (not wiped)',
			(await barGh.innerText()) === 'GitHub · Ada'
		);

		const barBumper = page.locator('[data-portable-bar] [data-bumper-n]');
		check('nested island seed inside crossed snippet', (await barBumper.innerText()) === '5');
		await page.locator('[data-portable-bar] [data-bumper]').click();
		await page.waitForTimeout(60);
		check(
			'crossed snippet is ALIVE — nested island 5 → 6',
			(await barBumper.innerText()) === '6',
			`n=${await barBumper.innerText()}`
		);

		check('no page errors', errors.length === 0, errors.join(' | '));
	});
});
