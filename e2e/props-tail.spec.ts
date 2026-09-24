// PROPS AFTER THE CONTENT — an island's props sidecar no longer sits next to the island; the page
// pass records it and the handle emits every sidecar at the END of the body, keyed by the region's
// fingerprint, one per distinct fingerprint. The hero and the text stream before the props bytes
// (one measured landing page had 480 KB of props above its LCP image).
//
// Guards: (1) SSR shape — no sidecar adjacent to any region, all sidecars after the last content,
// before the page seed, keyed and matching each region's `data-og-fp`, identical islands sharing
// one; (2) hydration reads them (click counts from the SSR `start`); (3) SPA navigation to a page
// with a different tail keeps working — the kept island survives with fresh props, the new island
// hydrates from the new tail, and back again.
// Usage: pnpm exec playwright test props-tail
import { test, check, island_graph } from './fixtures/index.ts';
import { ISLAND_GRAPH_SCRIPT_G_RE, ISLAND_HINT_G_RE, KIT_MARKER_RE } from './fixtures/re.ts';

const REGION_OPEN_G = /<ogygia-region\b[^>]*>/g;
const ENTRY_ATTR = /\bentry="([^"]+)"/;
const REGION_CLOSE = '</ogygia-region>';
// keyed sidecars also carry `id="og-props-<fp>"` and, on the JSON lane, `data-og-format="json"`
const SIDECAR_G = /<script type="application\/ogygia-props" data-ogygia-props(?:="([0-9a-f]+)")?[^>]*>/g;
const FP_ATTR = /data-og-fp="([0-9a-f]+)"/;

test.describe('PROPS TAIL: island props ride at the end of the body, keyed by fingerprint', () => {
	test('SSR: no adjacent sidecars; all keyed, after the content, deduped', async ({ baseURL }) => {
		const res = await fetch(baseURL + '/props-tail');
		const html = await res.text();
		check('/props-tail returns 200', res.status === 200);
		check('csr=false (no Kit bootstrap)', !KIT_MARKER_RE.test(html));

		const regions = [...html.matchAll(REGION_OPEN_G)].map((m) => m[0]);
		const fps = regions.map((r) => r.match(FP_ATTR)?.[1] ?? '');
		check('4 islands rendered (keeper + 3 tallies)', regions.length === 4, String(regions.length));
		check('every island carries data-og-fp', fps.every(Boolean), fps.join(','));

		// (1a) nothing adjacent: the text right after each `</ogygia-region>` is never a sidecar
		let adjacent = 0;
		let from = 0;
		for (;;) {
			const at = html.indexOf(REGION_CLOSE, from);
			if (at < 0) break;
			const after = html.slice(at + REGION_CLOSE.length, at + REGION_CLOSE.length + 40);
			if (after.includes('data-ogygia-props')) adjacent++;
			from = at + 1;
		}
		check('no sidecar adjacent to a region', adjacent === 0, `${adjacent} adjacent`);

		// (1b) every sidecar is keyed and sits after the page content, before the seed / body end
		const sidecars = [...html.matchAll(SIDECAR_G)];
		const keys = sidecars.map((m) => m[1] ?? '');
		check('all sidecars keyed', keys.every(Boolean), keys.join(','));
		const content_at = html.indexOf('data-after-islands');
		const first_sidecar_at = sidecars.length ? (sidecars[0].index ?? -1) : -1;
		check('sidecars come after the page content', first_sidecar_at > content_at, `${first_sidecar_at} vs ${content_at}`);
		const seed_at = html.indexOf('data-ogygia-page');
		check(
			'sidecars come before the page seed (or there is no seed)',
			seed_at < 0 || (sidecars.length > 0 && (sidecars[sidecars.length - 1].index ?? 0) < seed_at)
		);
		// (1c) keyed to the regions: every region's fp has a sidecar; identical twins share one
		check('every region fp has a sidecar', fps.every((fp) => keys.includes(fp)), `fps ${fps} keys ${keys}`);
		check('identical islands share one sidecar (3 sidecars for 4 regions)', sidecars.length === 3, String(sidecars.length));
		check('no duplicate sidecar keys', new Set(keys).size === keys.length);

		// (1d) island code is never hinted from the HTML: the islands' chunk lists ride the tail as ONE
		// island graph script, after the content, one list per distinct entry. (The runtime's own dep
		// preloads sit in the head beside it by design; they are not island hints.)
		check('no island modulepreload hint in the HTML', [...html.matchAll(ISLAND_HINT_G_RE)].length === 0);
		const graph_scripts = [...html.matchAll(ISLAND_GRAPH_SCRIPT_G_RE)];
		check('one island graph script', graph_scripts.length === 1, String(graph_scripts.length));
		check('the graph comes after the page content', (graph_scripts[0]?.index ?? 0) > content_at);
		const entries = new Set(regions.map((r) => r.match(ENTRY_ATTR)?.[1] ?? ''));
		const graph = island_graph(html);
		check(
			'every island entry on the page has its graph',
			[...entries].every((e) => graph.has(e)),
			`entries ${[...entries]} graph ${[...graph.keys()]}`
		);
	});

	test('browser: islands hydrate from the tail; SPA nav swaps tails; the kept island survives', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto('/props-tail', { waitUntil: 'networkidle' });
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 8000 }).catch(() => {});
		check(
			'all 4 islands hydrated',
			(await page.locator('ogygia-region[data-hydrated]').count()) === 4,
			String(await page.locator('ogygia-region[data-hydrated]').count())
		);
		// NO WATERFALL: at the wake the runtime preloaded each island's whole graph beside its
		// `import()`, so every chunk an island needs started before its entry finished downloading —
		// none waited to be discovered by parsing the entry.
		const late = await page.evaluate(() => {
			const graph_script = document.querySelector('script[data-ogygia-graph]');
			const wire = JSON.parse(graph_script?.textContent || '{"h":[],"e":{}}') as { h: string[]; e: Record<string, number[]> };
			const res = new Map(
				performance.getEntriesByType('resource').map((r) => [r.name, r as PerformanceResourceTiming] as const)
			);
			const out: string[] = [];
			for (const [entry, ids] of Object.entries(wire.e)) {
				const e = res.get(new URL(entry, location.href).href);
				if (!e) continue;
				for (const i of ids) {
					const c = res.get(new URL(wire.h[i], location.href).href);
					if (c && c.startTime > e.responseEnd) out.push(`${wire.h[i]} after ${entry}`);
				}
			}
			return { out, linked: document.querySelectorAll('link[data-ogygia-graph-preload]').length };
		});
		check('the runtime linked the woken islands’ graphs', late.linked > 0, String(late.linked));
		check('no chunk waited for its island entry to download', late.out.length === 0, late.out.join('\n'));
		const solo = page.locator('[data-tally="solo"] [data-tally-btn]');
		check('props arrived: solo starts at 20', (await solo.innerText()).includes('20'), await solo.innerText());
		await solo.click();
		await page.waitForTimeout(100);
		check('solo counts (21)', (await solo.innerText()).includes('21'), await solo.innerText());
		const twins = page.locator('[data-tally="twin"] [data-tally-btn]');
		check('both twins got the shared sidecar (10, 10)', (await twins.allInnerTexts()).every((t) => t.includes('10')));
		await twins.nth(1).click();
		await page.waitForTimeout(100);
		check(
			'twins are independent islands (second → 11, first stays 10)',
			(await twins.nth(1).innerText()).includes('11') && (await twins.nth(0).innerText()).includes('10')
		);

		// keeper: click twice, then SPA-navigate to B
		const keeper_btn = page.locator('[data-keeper-btn]');
		await keeper_btn.click();
		await keeper_btn.click();
		await page.waitForTimeout(100);
		check('keeper clicked twice on A', (await keeper_btn.innerText()).includes('2'));
		await page.locator('[data-to-b]').click();
		await page.waitForFunction(() => location.pathname.endsWith('/props-tail/b'), null, { timeout: 8000 });
		await page.waitForTimeout(300);
		check('SPA nav (no full reload): page errors none', errors.length === 0, errors.join(' | '));
		check('B rendered', (await page.locator('h1').innerText()).includes('page B'));
		check('kept island survived with its state (2 clicks)', (await keeper_btn.innerText()).includes('2'), await keeper_btn.innerText());
		check('kept island got fresh props from B\'s tail (page=B)', (await page.locator('[data-keeper-page]').innerText()) === 'B');
		const b_only = page.locator('[data-tally="b-only"] [data-tally-btn]');
		await page.waitForSelector('[data-tally="b-only"]', { timeout: 8000 }).catch(() => {});
		check('B island present with props (30)', (await b_only.innerText()).includes('30'), await b_only.innerText());
		await b_only.click();
		await page.waitForTimeout(100);
		check('B island hydrated from B\'s tail (31)', (await b_only.innerText()).includes('31'), await b_only.innerText());
		check('no stale A islands left', (await page.locator('[data-tally="solo"]').count()) === 0);

		// and back to A: the tail is swapped again
		await page.locator('[data-to-a]').click();
		await page.waitForFunction(() => /\/props-tail\/?$/.test(location.pathname), null, { timeout: 8000 });
		await page.waitForSelector('[data-tally="solo"]', { timeout: 8000 }).catch(() => {});
		await page.waitForTimeout(300);
		const solo2 = page.locator('[data-tally="solo"] [data-tally-btn]');
		check('back on A: solo re-rendered from A\'s tail (20)', (await solo2.innerText()).includes('20'), await solo2.innerText());
		await solo2.click();
		await page.waitForTimeout(100);
		check('back on A: solo hydrated (21)', (await solo2.innerText()).includes('21'));
		check('keeper still kept (2 clicks, page=A)', (await keeper_btn.innerText()).includes('2') && (await page.locator('[data-keeper-page]').innerText()) === 'A');
		check('no page errors across the round trip', errors.length === 0, errors.join(' | '));
	});
});
