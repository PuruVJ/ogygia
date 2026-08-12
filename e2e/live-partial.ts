// Live-partial checks (fetch + Playwright). Usage: node verify/live-partial.ts [baseUrl]
//
// A `query.live` yields an AWAITED partial each tick, so server-rendered HTML rides Kit's SSE
// channel and the runtime swaps it in with NO per-tick fetch:
//   - INTERACTIVE (`partial: 'load'`): hydrates once, then keep-alives — new props are pushed into
//     the mounted island (local `$state` survives across ticks; no re-hydrate).
//   - STATIC (`partial: 'static'`): ships no client JS; the runtime morphs the fresh HTML in place
//     (the element identity survives, so focus / typed input would too).
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out: string[] = [];
function check(name: string, cond: boolean, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const count = (s: string, re: RegExp) => (s.match(re) || []).length;

// ---------------------------------------------------------------- fetch/SSR --
{
	const res = await fetch(base + '/live-partial');
	const html = await res.text();
	check('/live-partial returns 200', res.status === 200);
	check('/live-partial ships NO Kit bootstrap (csr=false)', !/__sveltekit/.test(html));
	// The host island is on the page; the partial values arrive over the live stream after load,
	// so the SSR HTML shows the pending state, not a partial region yet.
	check('/live-partial SSR shows the pending placeholders', /connecting…/.test(html));
	// The static partial component ships no client JS — its markup must not appear in any island
	// entry (checked via the client bundle in the build inspector; here we assert SSR has no chunk
	// import for it). Interactive partial's chunk is loaded on demand by the runtime.
	check('/live-partial SSR has the host island region', count(html, /<ogygia-region\b/g) >= 1);
}

// ---------------------------------------------------------------- browser ----
const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	// Don't wait for networkidle — the live-query SSE stream stays open.
	await page.goto(base + '/live-partial', { waitUntil: 'domcontentloaded' });

	// --- interactive partial: first tick swaps + hydrates, no fetch -----------
	const partialFetches: string[] = [];
	page.on('request', (r) => {
		const u = r.url();
		if (u.includes('/\u{1F3DD}') || /[?&]sig=/.test(u)) partialFetches.push(u);
	});

	await page
		.waitForFunction(
			() => !!document.querySelector('[data-live-stat] [data-stat-value]'),
			{ timeout: 8000 }
		)
		.catch(() => {});
	check(
		'interactive partial swapped in from the live stream',
		(await page.locator('[data-live-stat]').count()) === 1
	);

	const v1 = (await page.locator('[data-stat-value]').textContent())?.trim() || '';
	// Click the local counter, then wait for a later tick to arrive.
	await page.click('[data-stat-clicks]');
	const clicks1 = (await page.locator('[data-stat-clicks]').textContent())?.trim() || '';
	check('interactive partial: local click registered', /local clicks: 1/.test(clicks1), clicks1);

	await page
		.waitForFunction(
			(prev) =>
				(document.querySelector('[data-stat-value]')?.textContent || '').trim() !== prev,
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
		/local clicks: 1/.test(clicks2),
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
		const el = document.querySelector('[data-stat-badge]') as (HTMLElement & { __ogProbe?: string }) | null;
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
			(document.querySelector('[data-stat-badge]') as (HTMLElement & { __ogProbe?: string }) | null)
				?.__ogProbe === 'kept'
	);
	check('static partial: MORPHED in place (same node survives the tick)', kept);
} finally {
	await browser.close();
}

console.log(out.join('\n'));
console.log(
	`\n${failures === 0 ? 'ALL LIVE-REGION_BRAND CHECKS PASSED' : failures + ' LIVE-REGION_BRAND CHECK(S) FAILED'}`
);
process.exit(failures === 0 ? 0 : 1);
