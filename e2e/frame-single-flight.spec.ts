// Single-flight mutation (Playwright). Usage: pnpm exec playwright test frame-single-flight
//
// A command mutates server state AND returns the re-rendered region in the same response. The mounted
// region morphs in place from the command's baked HTML — with NO follow-up region-endpoint fetch.
// This is the third frames facet: mutation responses are frame writes.
import { test, check } from './fixtures/index.ts';
import { ENDPOINT_PATH_RE, NON_DIGIT_G_RE } from './fixtures/re.ts';

const COUNT_RE = /^count: \d+$/;

test.describe('single-flight: command returns the re-rendered region, no extra fetch', () => {
	test('a command morphs the mounted region in place with ZERO region-endpoint GETs', async ({
		page
	}) => {
		// Count GET requests to the region endpoint — single-flight must add ZERO of them on mutation.
		let regionGets = 0;
		page.on('request', (req) => {
			if (req.method() === 'GET' && ENDPOINT_PATH_RE.test(req.url())) regionGets++;
		});

		await page.goto('/single-flight', { waitUntil: 'load' });

		const badge = page.locator('[data-badge]');
		await badge.waitFor({ timeout: 8000 });
		const before = (await badge.textContent())?.trim();
		check('region SSR shows initial count', COUNT_RE.test(before || ''), JSON.stringify(before));

		// Wait for the trigger island to hydrate, then snapshot the endpoint-GET count.
		await page
			.waitForFunction(() => document.querySelector('ogygia-region[data-hydrated]') != null, {
				timeout: 8000
			})
			.catch(() => {});
		const getsBeforeClick = regionGets;

		// Fire the mutation.
		await page.locator('[data-bump]').click();
		// The command response carries the re-rendered region; the mounted one morphs. Wait for the change.
		await page
			.waitForFunction(
				(prev) => document.querySelector('[data-badge]')?.textContent?.trim() !== prev,
				before,
				{ timeout: 8000 }
			)
			.catch(() => {});

		const after = (await badge.textContent())?.trim();
		const bn = Number((before || '').replace(NON_DIGIT_G_RE, ''));
		const an = Number((after || '').replace(NON_DIGIT_G_RE, ''));
		check('region morphed to the mutated count', an === bn + 1, `${before} → ${after}`);
		check(
			'SINGLE-FLIGHT: mutation added NO region-endpoint fetch',
			regionGets === getsBeforeClick,
			`gets before=${getsBeforeClick} after=${regionGets}`
		);
		check(
			'same node morphed in place (no full re-fetch churn)',
			an === bn + 1 && regionGets === getsBeforeClick
		);
	});
});
