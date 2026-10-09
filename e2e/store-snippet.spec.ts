// Store auto-subscriptions in a crossing snippet — the consumer CI regression. A `{#snippet}`
// handed to a hydrate island reads `$country` / `$language` (bare, member chain, template
// literal). The compiler must hoist the subscription VALUES at the host and rewrite the crossed
// body — the old behavior emitted `$country` verbatim into the runes-mode synth entry and the
// BUILD died inside virtual:ogygia/island/… (so this page building at all is half the test).
// The crossed copy must render the snapshot on SSR, survive hydration, and stay alive.
// Usage: pnpm exec playwright test store-snippet
import { test, check } from './fixtures/index.ts';
import { PORTABLE_BAR_RE } from './fixtures/re.ts';

const DATA_STATIC_RE = /data-static/;
const HOST_READ_RE = /host reads fr directly/;
const CC_RE = /data-cc[^>]*>fr</;
const LOC_RE = /data-loc[^>]*>locale: en-FR</;
const BUMPER_SEED_RE = /data-bumper-n[^>]*>7</;
const SUB_COUNTRY_RE = /__og_sub_country/;
const DOLLAR_COUNTRY_RE = /\$country/;

test.describe('REGRESSION: $store reads in a crossing snippet hoist as VALUE snapshots (no verbatim $-identifier in the synth)', () => {
	test('SSR', async ({ baseURL }) => {
		const raw = await (await fetch(baseURL + '/store-snippet')).text();
		check(
			'SSR: page built + served (the regression WAS a build failure)',
			DATA_STATIC_RE.test(raw)
		);
		// The host's own read still works (store sugar untouched outside the crossing).
		check('SSR: host-scope $store read intact', HOST_READ_RE.test(raw));
		// The crossed snippet rendered the SNAPSHOT values inside the island bar.
		const barMatch = raw.match(PORTABLE_BAR_RE);
		const bar = barMatch ? barMatch[0] : '';
		check('SSR: bare $country crossed as its value', CC_RE.test(bar), bar.slice(0, 160));
		check('SSR: template-literal + member chain crossed (en-FR)', LOC_RE.test(bar));
		check('SSR: nested island inside the crossed snippet seeded (7)', BUMPER_SEED_RE.test(bar));
		// The capture rides the wire under its rewritten prop name, with the VALUE, not the store.
		check('SSR: capture prop __og_sub_country in payload', SUB_COUNTRY_RE.test(raw));
		check(
			'SSR: no verbatim $-identifier leaked into payload/markup',
			!DOLLAR_COUNTRY_RE.test(raw),
			'found $country'
		);
	});

	test('Browser', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push('console: ' + m.text());
		});
		await page.goto('/store-snippet', { waitUntil: 'networkidle' });
		await page.waitForTimeout(250);

		const cc = page.locator('[data-portable-bar] [data-cc]');
		check('snapshot survives hydration (fr)', (await cc.innerText()) === 'fr');
		const loc = page.locator('[data-portable-bar] [data-loc]');
		check(
			'composed snapshot survives hydration (locale: en-FR)',
			(await loc.innerText()) === 'locale: en-FR'
		);

		const barBumper = page.locator('[data-portable-bar] [data-bumper-n]');
		check('nested island seed inside crossed snippet', (await barBumper.innerText()) === '7');
		await page.locator('[data-portable-bar] [data-bumper]').click();
		await page.waitForTimeout(60);
		check(
			'crossed snippet is ALIVE — nested island 7 → 8',
			(await barBumper.innerText()) === '8',
			`n=${await barBumper.innerText()}`
		);

		check('no page errors (incl. hydration mismatch)', errors.length === 0, errors.join(' | '));
	});
});
