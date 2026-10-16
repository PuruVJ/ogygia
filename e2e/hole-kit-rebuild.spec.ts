// A DEFERRED HOLE SURVIVES KIT REBUILDING THE DOCUMENT IN THE BROWSER. On a csr=true page Kit
// hydrates the whole document; when the served markup does not match what Svelte rendered (a
// post-SSR pass rewrote it — the fixture's hooks.server.ts strips one hydration marker), Svelte
// drops Kit's root and mounts it fresh. (A component THROWING while Kit hydrates is Kit's error page
// now, not a rebuild: the mismatch is the path that still rebuilds.) Every hole is then rendered by the client leg, which cannot mint a signed
// address: `endpoint=""`, and the fallback stood forever — a site header's account holes went
// dark for signed-in visitors. Now every top-level hole carries its identity (`data-og-hole`, the
// fingerprint of region id + props, computed the same way on both legs), the handle records each
// hole's server-minted facts under it in the document tail — OUTSIDE Kit's root, so the rebuild
// cannot take it — and the runtime hands a rebuilt hole its address back: the hole fetches, and
// the island inside its answer wakes.
//
//   pnpm exec playwright test hole-kit-rebuild
import { test, check, sleep } from './fixtures/index.ts';

const HOLE_TAG_G = /<ogygia-region[^>]*render="defer"[^>]*>/g;
const HOLE_WITH_ADDRESS_RE = /endpoint="[^"]+"[^>]*data-og-hole="[0-9a-f]{16}"/;
const HOLE_IDENTITY_G = /data-og-hole="([0-9a-f]{16})"/g;
const HOLES_RECORD_RE = /<script type="application\/ogygia-holes" data-ogygia-holes>(\{[\s\S]*?\})<\/script>/;

test.describe('deferred holes on a csr=true page Kit rebuilds in the browser', () => {
	test('SSR: every hole carries its address and identity; the tail records the facts outside Kit’s root', async ({ baseURL }) => {
		const html = await (await fetch(baseURL + '/hole-kit-rebuild/')).text();
		const holes = html.match(HOLE_TAG_G) || [];
		check('two holes on the page (a shared component keeps its marks on a csr=true page)', holes.length === 2, String(holes.length));
		check('each hole: endpoint + data-og-hole', holes.every((h) => HOLE_WITH_ADDRESS_RE.test(h)), holes.join('\n'));
		check('the runtime ships (the holes are ours to fetch)', /data-ogygia-runtime/.test(html));
		const record = HOLES_RECORD_RE.exec(html);
		check('the holes record is on the page', !!record);
		const identities = [...html.matchAll(HOLE_IDENTITY_G)].map((m) => m[1]);
		const facts = record ? (JSON.parse(record[1]) as Record<string, { endpoint: string }>) : {};
		check('the record names both holes by identity', identities.every((id) => typeof facts[id]?.endpoint === 'string' && facts[id].endpoint.includes('__ogygia__')), Object.keys(facts).join(','));
		check('the record sits AFTER Kit’s root (outside what a rebuild clears)', html.indexOf('data-ogygia-holes') > html.indexOf('kit.start('));
	});

	test('browser: Kit gives up hydrating, rebuilds the page, and the holes still fill', async ({ page }) => {
		const errs: string[] = [];
		const warns: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'error') errs.push('console: ' + m.text());
			if (m.type() === 'warning') warns.push(m.text());
		});
		// the server-rendered Boom, held from before Kit starts: a rebuild replaces it, a hydration keeps it
		await page.addInitScript(() =>
			document.addEventListener('DOMContentLoaded', () => {
				(window as unknown as { __ssr_boom: Element | null }).__ssr_boom = document.querySelector('[data-boom]');
			})
		);
		await page.goto('/hole-kit-rebuild/', { waitUntil: 'networkidle' });
		await sleep(500);

		const ssr_boom_gone = await page.evaluate(() => {
			const el = (window as unknown as { __ssr_boom: Element | null }).__ssr_boom;
			return !!el && !el.isConnected;
		});
		check('Kit DID give up hydrating: the server DOM was replaced (the regression needs the rebuild)', ssr_boom_gone, warns.slice(0, 2).join('; '));
		check('the page was rebuilt (Boom renders again)', (await page.locator('[data-boom]').count()) === 1);
		const kbtn = page.locator('[data-kit-btn]');
		await kbtn.click();
		check('Kit’s client is alive after the rebuild', (await kbtn.textContent())!.includes('kit:1'));

		check('no hole was left without an address', (await page.locator('ogygia-region[render="defer"]:not([endpoint]), ogygia-region[render="defer"][endpoint=""]').count()) === 0);
		await page.waitForSelector('[data-rebuild-static-hole] [data-server-greeting]', { timeout: 10_000 });
		check('static hole fetched and swapped in after the rebuild', (await page.locator('[data-rebuild-static-hole] [data-server-greeting]').textContent())!.includes('Rebuilt, stranger'));
		check('its fallback is gone', (await page.locator('[data-rebuild-fallback]').count()) === 0);

		await page.waitForSelector('[data-rebuild-island-hole] ogygia-region[wake="load"][data-hydrated] [data-counter]', { timeout: 10_000 });
		const cbtn = page.locator('[data-rebuild-island-hole] [data-counter] button');
		check('the island inside the hole’s answer hydrated with its props (start=5)', (await cbtn.textContent())!.includes('count is 5'));
		await cbtn.click();
		check('and is interactive after the rebuild (5 → 6)', (await cbtn.textContent())!.includes('count is 6'));
		check('no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
	});
});
