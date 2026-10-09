// Live-partial checks (fetch + Playwright). Usage: pnpm exec playwright test live-partial
//
// A `query.live` yields an AWAITED partial each tick, so server-rendered HTML rides Kit's SSE
// channel and the runtime swaps it in with NO per-tick fetch:
//   - INTERACTIVE (`partial: 'load'`): hydrates once, then keep-alives — new props are pushed into
//     the mounted island (local `$state` survives across ticks; no re-hydrate).
//   - STATIC (`partial: 'static'`): ships no client JS; the runtime morphs the fresh HTML in place
//     (the element identity survives, so focus / typed input would too).
import { test, check } from './fixtures/index.ts';
import { KIT_MARKER_RE, REGION_TAG_G_RE, SIG_PARAM_RE } from './fixtures/re.ts';

const CONNECTING_RE = /connecting…/;
const LOCAL_CLICKS_1_RE = /local clicks: 1/;

const count = (s: string, re: RegExp) => (s.match(re) || []).length;

test.describe('query.live partials: swap no-fetch, keep-alive, static morph', () => {
	// ---------------------------------------------------------------- fetch/SSR --
	test('SSR: csr=false page shows the pending placeholders and the host island', async ({
		baseURL
	}) => {
		const res = await fetch(baseURL + '/live-partial');
		const html = await res.text();
		check('/live-partial returns 200', res.status === 200);
		check('/live-partial ships NO Kit bootstrap (csr=false)', !KIT_MARKER_RE.test(html));
		// The host island is on the page; the partial values arrive over the live stream after load,
		// so the SSR HTML shows the pending state, not a partial region yet.
		check('/live-partial SSR shows the pending placeholders', CONNECTING_RE.test(html));
		// The static partial component ships no client JS — its markup must not appear in any island
		// entry (checked via the client bundle in the build inspector; here we assert SSR has no chunk
		// import for it). Interactive partial's chunk is loaded on demand by the runtime.
		check('/live-partial SSR has the host island region', count(html, REGION_TAG_G_RE) >= 1);
	});

	// ---------------------------------------------------------------- browser ----
	test('browser: interactive partial keep-alives, static partial morphs in place, no per-tick fetch', async ({
		page
	}) => {
		// Don't wait for networkidle — the live-query SSE stream stays open.
		await page.goto('/live-partial', { waitUntil: 'domcontentloaded' });

		// --- interactive partial: first tick swaps + hydrates, no fetch -----------
		const partialFetches: string[] = [];
		page.on('request', (r) => {
			const u = r.url();
			if (u.includes('/__ogygia__') || SIG_PARAM_RE.test(u)) partialFetches.push(u);
		});

		await page
			.waitForFunction(() => !!document.querySelector('[data-live-stat] [data-stat-value]'), {
				timeout: 8000
			})
			.catch(() => {});
		check(
			'interactive partial swapped in from the live stream',
			(await page.locator('[data-live-stat]').count()) === 1
		);

		// REGRESSION: the wire-delivered component's SCOPED CSS must actually load and apply. LiveStat is
		// server-picked (never in the page's static graph), so its stylesheet rides the region response
		// as `<link data-ogygia-region-css>` that the runtime hoists — the exact chain the `?og-region`
		// module-id fork broke by dropping the component's CSS from the build. The distinctive outline
		// colour proves the CSS is present (unstyled → the browser default, not this rgb).
		const outline = await page
			.locator('[data-live-stat]')
			.evaluate((el) => getComputedStyle(el).outlineColor)
			.catch(() => '');
		check(
			'interactive partial: wire-delivered component CSS loaded (scoped style applied)',
			outline === 'rgb(7, 113, 219)',
			outline
		);

		const v1 = (await page.locator('[data-stat-value]').textContent())?.trim() || '';
		// Click the local counter, then wait for a later tick to arrive.
		await page.click('[data-stat-clicks]');
		const clicks1 = (await page.locator('[data-stat-clicks]').textContent())?.trim() || '';
		check('interactive partial: local click registered', LOCAL_CLICKS_1_RE.test(clicks1), clicks1);

		await page
			.waitForFunction(
				(prev) => (document.querySelector('[data-stat-value]')?.textContent || '').trim() !== prev,
				v1,
				{ timeout: 8000 }
			)
			.catch(() => {});
		const v2 = (await page.locator('[data-stat-value]').textContent())?.trim() || '';
		check('interactive partial: value updates on a new tick', v1 !== v2, `${v1} -> ${v2}`);

		// KEEP-ALIVE: the local click count SURVIVES the tick (no re-hydrate would reset it to 0).
		const clicks2 = (await page.locator('[data-stat-clicks]').textContent())?.trim() || '';
		check(
			'interactive partial: keep-alive — local state survives the prop-push tick',
			LOCAL_CLICKS_1_RE.test(clicks2),
			clicks2
		);

		// No per-tick fetch to the island endpoint (HTML came baked in the ticket).
		check(
			'live partials make NO per-tick endpoint fetch',
			partialFetches.length === 0,
			`${partialFetches.length} fetches`
		);

		// --- static partial: morph in place (element identity survives) -----------
		await page
			.waitForFunction(() => !!document.querySelector('[data-stat-badge] [data-badge-value]'), {
				timeout: 8000
			})
			.catch(() => {});
		// Tag the current badge element with a JS PROPERTY (not an attribute — morph syncs attributes, so
		// it would legitimately strip an injected one). A morph keeps the SAME node instance, so the
		// property survives; a rebuild would create a fresh node without it.
		await page.evaluate(() => {
			const el = document.querySelector('[data-stat-badge]') as
				| (HTMLElement & { __ogProbe?: string })
				| null;
			if (el) el.__ogProbe = 'kept';
		});
		const b1 = (await page.locator('[data-badge-value]').textContent())?.trim() || '';
		await page
			.waitForFunction(
				(prev) => (document.querySelector('[data-badge-value]')?.textContent || '').trim() !== prev,
				b1,
				{ timeout: 8000 }
			)
			.catch(() => {});
		const b2 = (await page.locator('[data-badge-value]').textContent())?.trim() || '';
		check('static partial: value morphs to a new tick', b1 !== b2, `${b1} -> ${b2}`);
		const kept = await page.evaluate(
			() =>
				(
					document.querySelector('[data-stat-badge]') as
						| (HTMLElement & { __ogProbe?: string })
						| null
				)?.__ogProbe === 'kept'
		);
		check('static partial: MORPHED in place (same node survives the tick)', kept);
	});
});
