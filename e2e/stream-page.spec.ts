// STREAMED PAGES (`page(async function* ...)`): the first yield flushes immediately, later
// yields ride the SAME response as inert <template data-og-late> chunks, and the inline boot
// swaps each into its og-late-slot as it parses. Islands inside a late chunk are custom
// elements — they wake on adoption with zero orchestration.
// Usage: pnpm exec playwright test stream-page
import { test, check } from './fixtures/index.ts';
import { ONE_RE } from './fixtures/re.ts';

test.describe('streamed pages (yield regions): flush-before-slow-yield timing, template chunks, late island wakes on adoption, SPA-swap twin', () => {
	// 1) WIRE truth: the raw response carries skeleton BEFORE payload, payload inside a template
	test('wire: skeleton before payload, payload inside an inert template', async ({ baseURL }) => {
		const raw = await (await fetch(baseURL + '/rtr/stream')).text();
		const i_skel = raw.indexOf('data-stream-skeleton');
		const i_tpl = raw.indexOf('<template data-og-late');
		const i_payload = raw.indexOf('data-stream-payload');
		check('wire: skeleton present in the flushed part', i_skel > -1);
		check('wire: late chunk is an inert template', i_tpl > -1);
		check(
			'wire: payload arrives AFTER the skeleton (streamed order)',
			i_payload > i_tpl && i_tpl > i_skel
		);
		check('wire: boot script present once', raw.split('data-og-late-boot').length === 2);
		check('wire: slot wrapper present', raw.includes('og-late-slot'));
	});

	// 2) TIMING truth: the first chunk does NOT wait for the slow yield. Assert the DELTA on one
	// response — first-chunk time vs full-body time — so server/machine jitter can't flake it:
	// the full body includes the 150ms upstream sleep, the flushed part must not.
	test('timing: the first chunk does NOT wait for the slow yield', async ({ baseURL }) => {
		const t0 = performance.now();
		// identity: a compressing middleware (vite preview, some CDNs) buffers while it gzips,
		// which would collapse the very timing this section proves — measure the raw stream
		const res = await fetch(baseURL + '/rtr/stream', {
			headers: { 'accept-encoding': 'identity' }
		});
		const reader = res.body!.getReader();
		const chunks: string[] = [];
		const dec = new TextDecoder();
		let t_first = 0;
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!t_first) t_first = performance.now() - t0;
			chunks.push(dec.decode(value, { stream: true }));
		}
		const t_full = performance.now() - t0;
		check('timing: first chunk holds the skeleton', chunks[0]?.includes('data-stream-skeleton'));
		check(
			'timing: first chunk beat the full body by ~the upstream sleep',
			t_full - t_first >= 100,
			`first ${t_first.toFixed(0)}ms, full ${t_full.toFixed(0)}ms`
		);
	});

	// 2b) LATE REGIONS (streamed load data): a load's promise-of-region resolves down the SAME
	// response — placeholder in the flushed part, the baked region as a completion-order chunk.
	test('late regions: a load promise-of-region resolves down the SAME response', async ({
		baseURL
	}) => {
		const raw = await (await fetch(baseURL + '/rtr/stream-region')).text();
		const i_skel = raw.indexOf('data-region-skeleton');
		const i_slot = raw.indexOf('og-late-slot');
		const i_tpl = raw.indexOf('<template data-og-late="r');
		const i_payload = raw.indexOf('data-stream-payload');
		check('late region: placeholder in the flushed part', i_skel > -1 && i_slot > -1);
		check('late region: chunk targets the region slot (r-id)', i_tpl > -1);
		check(
			'late region: baked payload arrives after the flush',
			i_payload > i_tpl && i_tpl > i_skel
		);
	});

	// 3) BROWSER truth: payload swapped in, template consumed, the LATE island is interactive
	test('browser: payload swapped in, template consumed, LATE island interactive + SPA-swap twin', async ({
		page
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push('console: ' + m.text());
		});
		// A streamed page holds the connection open for its late chunks, so `networkidle` never
		// fires — wait for the initial document, then the explicit settle below (as the script did).
		await page.goto('/rtr/stream', { waitUntil: 'domcontentloaded' });
		await page.waitForTimeout(400);
		check(
			'browser: payload swapped into the slot',
			(await page.locator('[data-stream-payload]').count()) === 1
		);
		check('browser: skeleton gone', (await page.locator('[data-stream-skeleton]').count()) === 0);
		check(
			'browser: template consumed',
			(await page.locator('template[data-og-late]').count()) === 0
		);
		const btn = page.locator('[data-stream-island]');
		await btn.click();
		await page.waitForTimeout(80);
		check(
			'browser: LATE island woke + counts',
			ONE_RE.test(await btn.innerText()),
			await btn.innerText()
		);

		// 4) SPA-swap twin: navigate away and back — the runtime applies templates post-swap
		await page.goto('/rtr/', { waitUntil: 'domcontentloaded' });
		// Prefer the SPA link; fall back to a hard nav. Bound the click so the fallback can run —
		// under the test runner an unbounded click auto-waits the WHOLE test timeout (the script's
		// raw-library click had a 30s default, then this .catch fired).
		await page
			.click('a[href*="/rtr/stream"]', { timeout: 3000 })
			.catch(() => page.goto('/rtr/stream', { waitUntil: 'domcontentloaded' }));
		await page.waitForTimeout(700);
		check(
			'SPA: payload present after client-side nav',
			(await page.locator('[data-stream-payload]').count()) === 1
		);
		check('no page errors', errors.length === 0, errors.join(' | '));
	});
});
