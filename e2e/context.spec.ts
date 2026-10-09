// Cross-island context (`createContext()` + `<Context of value>`) exercised against every other
// area of the library: hydration strategies (load/idle/visible/defer), nested islands, lakes,
// nested providers (shadowing), plain values + defaults, transportable-prop coexistence, and SPA
// navigation. A live [ogygia.wire] value reunites into ONE instance across roots; a plain value is
// a per-consumer snapshot; a missing provider yields the default.
// Usage: pnpm exec playwright test context
import { test, check } from './fixtures/index.ts';

const PROVIDE_TAG_RE = /<ogygia-provide\b/;
const SSR_LOAD_COUNT_RE = /data-ctx-reader="load"[^>]*>[\s\S]*?data-ctx-count[^>]*>(-?\d+)</;
const PLAIN_GREETING_RE = /data-plain-greeting="hi-from-provide"/;
const PLAIN_COUNT_RE = /data-plain-count="5"/;
const SSR_LAKE_COUNT_RE = /data-ctx-reader="in-lake"[^>]*>[\s\S]*?data-ctx-count[^>]*>(-?\d+)</;
const PROVIDE_PAGE_RE = /data-ogygia-provide-page/;
const SSR_SETCTX_THEME_RE = /data-setctx-reader="load"[^>]*data-setctx-theme="([^"]*)"/;

test.describe('Provide + drop-in setContext + createContext: DOM-bridged, live across roots', () => {
	test('SSR of the matrix page + hydrated matrix + liveness', async ({ page, baseURL }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push('console: ' + m.text());
		});

		// ---------- SSR of the matrix page ----------
		const raw = await (await fetch(baseURL + '/context')).text();
		check('SSR: provider emits <ogygia-provide> with values', PROVIDE_TAG_RE.test(raw));
		check('SSR: context value serialized into the DOM', raw.includes('data-ogygia-provide'));
		const ssrLoad = raw.match(SSR_LOAD_COUNT_RE)?.[1];
		check('SSR: load reader reads context (5, no prop)', ssrLoad === '5', `count=${ssrLoad}`);
		// RAW Svelte getContext (no ogygia handle) reads a <Provide> string entry + the live counter.
		check(
			'SSR: plain getContext island reads Provide values',
			PLAIN_GREETING_RE.test(raw) && PLAIN_COUNT_RE.test(raw)
		);

		// ---------- Hydrated matrix ----------
		await page.goto('/context', { waitUntil: 'networkidle' });
		await page.waitForTimeout(250);

		const count = (label: string) =>
			page.locator(`[data-ctx-reader="${label}"] [data-ctx-count]`).innerText();
		const isInstance = (label: string) =>
			page.locator(`[data-ctx-reader="${label}"]`).getAttribute('data-is-instance');

		// Strategies all decoded a real instance from context (no prop)
		check('load reader: real instance', (await isInstance('load')) === 'true');
		check('idle reader: real instance', (await isInstance('idle')) === 'true');
		check(
			'load reader count == SSR (no reset)',
			(await count('load')) === '5',
			`count=${await count('load')}`
		);

		// Raw `getContext('key')` island — unchanged Svelte — reads the <Provide> across the island split.
		const pGreet = await page.locator('[data-plain-reader]').getAttribute('data-plain-greeting');
		const pCount = await page.locator('[data-plain-reader]').getAttribute('data-plain-count');
		check(
			'plain getContext island reads Provide across roots (client)',
			pGreet === 'hi-from-provide' && pCount === '5',
			`${pGreet}/${pCount}`
		);

		// Nested-island inner reader (degraded + hydrated with outer) reads context
		check(
			'nested-island reader reads context',
			(await count('nested-inner')) === '5',
			`count=${await count('nested-inner')}`
		);

		// Coexist: same counter via prop AND via context → identical live instance
		check(
			'coexist: prop and context are the SAME instance',
			(await page.locator('[data-ctx-coexist]').getAttribute('data-same')) === 'true'
		);
		check(
			'coexist: context count matches',
			(await page.locator('[data-ctx-coexist] [data-coexist-ctx]').innerText()) === '5'
		);

		// Nested provider shadowing: inner sees 99, outer sees 5
		check(
			'shadow: inner provider wins (99)',
			(await count('inner-scope')) === '99',
			`count=${await count('inner-scope')}`
		);
		check(
			'shadow: outer scope unaffected (5)',
			(await count('outer-scope')) === '5',
			`count=${await count('outer-scope')}`
		);

		// Plain value + default + orphan
		check(
			'plain value: provided theme = dark',
			(await page.locator('[data-ctx-theme="provided"]').innerText()) === 'dark'
		);
		check(
			'plain value: default theme = light',
			(await page.locator('[data-ctx-theme="defaulted"]').innerText()) === 'light'
		);
		check(
			'orphan context: default returned',
			(await page.locator('[data-ctx-orphan]').innerText()) === 'orphan-default'
		);

		// ---------- Liveness: one write repaints every live reader ----------
		await page.locator('[data-ctx-writer] button').click();
		await page.waitForTimeout(80);
		check(
			'write repaints load reader',
			(await count('load')) === '6',
			`count=${await count('load')}`
		);
		check(
			'write repaints idle reader (shared)',
			(await count('idle')) === '6',
			`count=${await count('idle')}`
		);
		check(
			'write repaints nested-island reader',
			(await count('nested-inner')) === '6',
			`count=${await count('nested-inner')}`
		);
		check(
			'write repaints coexist (prop path too)',
			(await page.locator('[data-ctx-coexist] [data-coexist-prop]').innerText()) === '6'
		);
		check('shadow inner unaffected by outer write (99)', (await count('inner-scope')) === '99');

		// Deferred CLIENT island (defer+hydrate): fetched from the endpoint, then hydrated on the client,
		// where the DOM walk joins the live instance.
		await page.waitForTimeout(250);
		check(
			'defer+hydrate island joins live instance',
			(await isInstance('defer-hydrate')) === 'true' && (await count('defer-hydrate')) === '6',
			`count=${await count('defer-hydrate')}`
		);

		// Pure SERVER island (defer only): rendered in isolation on the endpoint with no page provider,
		// and never client-hydrated — so it can only ever see the context default. This is the documented
		// server-island isolation boundary, not a bug.
		check(
			'server island sees only the default (isolated render)',
			(await count('server')) === '-1' && (await isInstance('server')) === 'false',
			`count=${await count('server')}`
		);

		// Visible reader: below the fold, still SSR (5) until scrolled; scrolling hydrates it and it
		// LATE-JOINS the already-mutated instance (6), proving late hydration reunites.
		check(
			'visible reader still SSR before scroll (5)',
			(await count('visible')) === '5',
			`count=${await count('visible')}`
		);
		await page.locator('[data-ctx-reader="visible"]').scrollIntoViewIfNeeded();
		await page.waitForTimeout(150);
		check(
			'visible reader late-joins live instance (6)',
			(await count('visible')) === '6',
			`count=${await count('visible')}`
		);

		check('matrix: no page errors / hydration mismatches', errors.length === 0, errors.join(' | '));
	});

	test('Island inside a frozen lake reads the page provider', async ({ page, baseURL }) => {
		const lakeRaw = await (await fetch(baseURL + '/context/lake')).text();
		const ssrLake = lakeRaw.match(SSR_LAKE_COUNT_RE)?.[1];
		check('lake SSR: island-in-lake reads context (7)', ssrLake === '7', `count=${ssrLake}`);
		const lerrs: string[] = [];
		page.on('pageerror', (e) => lerrs.push(e.message));
		await page.goto('/context/lake', { waitUntil: 'networkidle' });
		await page.waitForTimeout(200);
		const lakeCount = await page
			.locator('[data-ctx-reader="in-lake"] [data-ctx-count]')
			.innerText();
		check(
			'lake: self-hydrated island-in-lake reads context (7)',
			lakeCount === '7',
			`count=${lakeCount}`
		);
		check('lake: no page errors', lerrs.length === 0, lerrs.join(' | '));
	});

	test('Context after SPA navigation', async ({ page }) => {
		const nerrs: string[] = [];
		page.on('pageerror', (e) => nerrs.push(e.message));
		await page.goto('/nested', { waitUntil: 'networkidle' });
		await page.locator('[data-ctx-nav-link]').click();
		await page.waitForTimeout(250);
		const navCount = () => page.locator('[data-ctx-reader="nav"] [data-ctx-count]').innerText();
		check(
			'SPA nav: reader reads context on new page (3)',
			(await navCount()) === '3',
			`count=${await navCount()}`
		);
		// Regression: the destination page's CSS must survive island `<svelte:head>` hydration. Clean
		// in-place hydration runs that head reconciliation, which removes a TRAILING head-node range —
		// so the router inserts SPA stylesheets at the TOP of <head>. Before the fix, this page's
		// `:global(ogygia-region){display:block}` was reclaimed, collapsing the layout until the reader
		// island overlapped the writer button (making it unclickable).
		const navRegionDisplay = await page.evaluate(
			() => getComputedStyle(document.querySelector('ogygia-region')!).display
		);
		check(
			'SPA nav: destination page CSS survives hydration (region display:block)',
			navRegionDisplay === 'block',
			navRegionDisplay
		);
		await page.locator('[data-ctx-writer] button').click();
		await page.waitForTimeout(80);
		check(
			'SPA nav: live update works after nav (4)',
			(await navCount()) === '4',
			`count=${await navCount()}`
		);
		check('SPA nav: no page errors', nerrs.length === 0, nerrs.join(' | '));
	});

	// ---------- Drop-in setContext bridge (import swap, no <Provide>) ----------
	// A csr=false layout imports `setContext` from ogygia (the ONLY change from a plain Svelte layout)
	// and sets a plain object, a string, and a live transportable. The handle emits ONE page-level
	// `<script data-ogygia-provide-page>` marker; child islands read it via UNCHANGED raw
	// getContext('key') across the island-root split. This is the zero-template-change adoption path.
	test('Drop-in setContext bridge (import swap, no <Provide>)', async ({ page, baseURL }) => {
		const sraw = await (await fetch(baseURL + '/ctx-setcontext')).text();
		check('setContext SSR: page-level marker emitted', PROVIDE_PAGE_RE.test(sraw));
		const ssrTheme = sraw.match(SSR_SETCTX_THEME_RE)?.[1];
		check('setContext SSR: island reads context (midnight)', ssrTheme === 'midnight', ssrTheme);

		const serrs: string[] = [];
		page.on('pageerror', (e) => serrs.push(e.message));
		await page.goto('/ctx-setcontext', { waitUntil: 'networkidle' });
		await page.waitForTimeout(200);
		const sattr = (a: string) => page.locator('[data-setctx-reader="load"]').getAttribute(a);
		check('setContext client: theme = midnight', (await sattr('data-setctx-theme')) === 'midnight');
		check(
			'setContext client: appName = playground',
			(await sattr('data-setctx-app')) === 'playground'
		);
		check(
			'setContext client: live transportable revived',
			(await sattr('data-setctx-live')) === 'true'
		);
		check(
			'setContext client: count kept (8)',
			(await sattr('data-setctx-count')) === '8',
			`count=${await sattr('data-setctx-count')}`
		);
		// Liveness: bumping the shared instance repaints the reader (proves a LIVE bridge, not a snapshot)
		await page.locator('[data-setctx-writer]').click();
		await page.waitForTimeout(80);
		check(
			'setContext liveness: writer bump repaints reader (9)',
			(await sattr('data-setctx-count')) === '9',
			`count=${await sattr('data-setctx-count')}`
		);
		// Visible island below the fold late-hydrates, still reads context AND late-joins the instance
		await page.locator('[data-setctx-reader="visible"]').scrollIntoViewIfNeeded();
		await page.waitForTimeout(150);
		const svis = await page
			.locator('[data-setctx-reader="visible"]')
			.getAttribute('data-setctx-count');
		check('setContext visible: reads context + late-joins (9)', svis === '9', `count=${svis}`);
		check('setContext: no page errors', serrs.length === 0, serrs.join(' | '));
	});
});
