// Frame-store checks (Playwright). Usage: pnpm exec playwright test frame-dedupe
//
// Proves the two headline properties of the frames architecture at runtime:
//   1. dedupe   — three identical server islands (same call → same endpoint → same address) fetch
//                 the region endpoint EXACTLY ONCE; all three still render.
//   2. no-clobber — the shared response fans out to every twin (all show the real content).
//
// The staleness/version discipline is covered deterministically in test/frame-store.test.ts.
import { test, check } from './fixtures/index.ts';
import { ENDPOINT_PATH_RE, REGION_ENDPOINT_G_RE } from './fixtures/re.ts';

const ISLANDS_RE = /\/_islands\b/;

test.describe('frame store: identical twins share ONE endpoint fetch', () => {
	test('three identical server islands fetch the endpoint exactly once, all three render', async ({
		page
	}) => {
		// Count requests to the region endpoint (the __ogygia__ path, encoded or literal).
		const endpointHits: string[] = [];
		page.on('request', (req) => {
			const u = req.url();
			if (ENDPOINT_PATH_RE.test(u) || ISLANDS_RE.test(u)) endpointHits.push(u);
		});

		await page.goto('/defer-twins', { waitUntil: 'load' });

		// SSR: three deferred regions, all sharing ONE endpoint (same sig).
		const html = await page.content();
		const eps = [...html.matchAll(REGION_ENDPOINT_G_RE)].map((m) => m[1]);
		check('three deferred twins in SSR', eps.length === 3, `got ${eps.length}`);
		check(
			'all three share one endpoint (same call)',
			new Set(eps).size === 1,
			`${new Set(eps).size} distinct`
		);

		// Wait for all three to swap in.
		await page
			.waitForFunction(
				() => document.querySelectorAll('ogygia-region[data-hydrated]').length >= 3,
				{ timeout: 10000 }
			)
			.catch(() => {});

		const rendered = await page.locator('ogygia-region strong').count();
		check('all three twins rendered the component', rendered === 3, `rendered ${rendered}`);
		const fallbacksGone = await page.locator('[data-fallback]').count();
		check('fallbacks all replaced', fallbacksGone === 0, `${fallbacksGone} left`);

		// The whole point: one fetch for three identical calls.
		check(
			'endpoint fetched EXACTLY once (dedupe)',
			endpointHits.length === 1,
			`${endpointHits.length} hits`
		);
	});
});
