// LAZY RUNTIME CHUNKS: the built runtime is three lazily loaded pieces around a small boot —
// `hydrate-core` (Svelte's `hydrate`, the provider, the props parse, and the HYDRATE-phase features)
// on the first island that wakes, `router-nav` (fetch + cache, head merge, reconcile) on the first
// prefetch or click, `interaction-replay` on the first arm. Proven on the network against the built
// playground: every script fetched at boot is read, and none may carry a string that lives only in
// `hydrate-core` (the discard warning's text) or only in `router-nav` (`x-ogygia-spa`, the navigation
// fetch header); the first wake fetches the former, the first prefetch the latter.
//
// AND NO SVELTE AT BOOT. The playground uses `live`, `wire`, `context` and remote seeds — every
// feature whose module reaches Svelte — and they are HYDRATE-phase features (link/runtime-entry.ts),
// so Svelte's client runtime (one ~200 KB chunk in a real app) must not be among the boot's scripts:
// it arrives with the first wake, when `hydrate()` needs it anyway.
// Usage: pnpm exec playwright test lazy-chunks
import { test, check } from './fixtures/index.ts';

/** A string only the hydrate core carries: the foreign-mutation detector's warning text. (The
 *  `data-og-recovered` MARK it sets is not unique — the boot's hydration beacon reads it.) */
const HYDRATE_CORE_MARKER = 'discarded its ENTIRE server-rendered DOM';
/** A string only Svelte's client runtime carries: its error-code URLs, kept in production builds. */
const SVELTE_RUNTIME_MARKER = 'svelte.dev/e/';
/** A string only the navigation chunk carries (the SPA fetch header). */
const ROUTER_NAV_MARKER = 'x-ogygia-spa';
const RUNTIME_RE = /\/og-runtime\.[^/]+\.js$/;

test.describe('lazy runtime chunks: hydrate core on first wake, navigation on first prefetch', () => {
	test('boot fetches neither; the first wake fetches the hydrate core, the first hover the navigation', async ({
		page
	}) => {
		const scripts: string[] = [];
		page.on('response', (r) => {
			if (r.request().resourceType() === 'script') scripts.push(r.url());
		});
		const bodies = async (urls: string[]) =>
			Promise.all(urls.map(async (u) => ({ u, text: await (await fetch(u)).text() })));
		const carrying = (list: Array<{ u: string; text: string }>, marker: string) =>
			list.filter((b) => b.text.includes(marker)).map((b) => b.u);

		await page.goto('/lazy-runtime', { waitUntil: 'networkidle' });
		await page.waitForTimeout(400);
		check('runtime booted (ogygia-region defined)', await page.evaluate(() => !!customElements.get('ogygia-region')));
		check('boot: the runtime chunk was fetched', scripts.some((u) => RUNTIME_RE.test(u)), scripts.join('\n'));
		check(
			'boot: no island hydrated (visible is below the fold, interaction is cold)',
			(await page.locator('ogygia-region[data-hydrated]').count()) === 0
		);
		const boot_scripts = [...scripts];
		const boot = await bodies(boot_scripts);
		check(
			`boot: no fetched script carries the hydrate core (${boot_scripts.length} scripts read)`,
			carrying(boot, HYDRATE_CORE_MARKER).length === 0,
			carrying(boot, HYDRATE_CORE_MARKER).join('\n')
		);
		check(
			'boot: no fetched script carries the navigation',
			carrying(boot, ROUTER_NAV_MARKER).length === 0,
			carrying(boot, ROUTER_NAV_MARKER).join('\n')
		);
		check(
			'boot: no fetched script is Svelte’s client runtime (it waits for the first wake)',
			carrying(boot, SVELTE_RUNTIME_MARKER).length === 0,
			carrying(boot, SVELTE_RUNTIME_MARKER).join('\n')
		);

		// The first wake: click the interaction island → the hydrate core + the island's chunk.
		await page.locator('[data-i-btn]').click();
		await page.waitForSelector('ogygia-region[wake="interaction"][data-hydrated]', { timeout: 8000 });
		await page.waitForTimeout(300);
		const after_wake = await bodies(scripts.slice(boot_scripts.length));
		check(
			'wake: the first wake fetched the hydrate core',
			carrying(after_wake, HYDRATE_CORE_MARKER).length === 1,
			after_wake.map((b) => b.u).join('\n')
		);
		check(
			'wake: Svelte’s client runtime arrived with the first wake',
			carrying(after_wake, SVELTE_RUNTIME_MARKER).length > 0,
			after_wake.map((b) => b.u).join('\n')
		);
		check('wake: still no navigation chunk', carrying(after_wake, ROUTER_NAV_MARKER).length === 0);
		check('wake: the click replayed (count 1)', (await page.locator('[data-i-count]').innerText()) === '1');

		// The visible island below the fold wakes on scroll, from the already-loaded core.
		const before_scroll = scripts.length;
		await page.locator('[data-counter]').scrollIntoViewIfNeeded();
		await page.waitForSelector('ogygia-region[wake="visible"][data-hydrated]', { timeout: 8000 });
		check('visible island hydrated after scroll', (await page.locator('[data-counter] button').innerText()).includes('5'));
		const after_scroll = await bodies(scripts.slice(before_scroll));
		check('scroll: the hydrate core was not fetched again', carrying(after_scroll, HYDRATE_CORE_MARKER).length === 0);

		// The first prefetch (hover on a preload-marked link) loads the navigation chunk.
		const before_hover = scripts.length;
		await page.locator('[data-prefetch-link]').hover();
		await page.waitForTimeout(600);
		const after_hover = await bodies(scripts.slice(before_hover));
		check(
			'hover: the first prefetch fetched the navigation chunk',
			carrying(after_hover, ROUTER_NAV_MARKER).length === 1,
			after_hover.map((b) => b.u).join('\n')
		);
	});
});
