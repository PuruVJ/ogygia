// LAZY RUNTIME CHUNKS: the built runtime is three lazily loaded pieces around a small boot —
// `hydrate-core` (Svelte's `hydrate`, the provider, the props parse) on the first island that
// wakes, `router-nav` on the first prefetch or click, `interaction-replay` on the first arm. A page
// whose islands all wake on `visible` / `interaction` must therefore boot WITHOUT fetching Svelte's
// client runtime; the first wake brings it in. Proven on the network: every script fetched before
// the wake is read and must not carry Svelte's client-runtime error namespace (present, as a string
// literal, in any prod build of `svelte/internal/client`).
// Usage: pnpm exec playwright test lazy-chunks
import { test, check } from './fixtures/index.ts';

/** A string literal every production build of Svelte's client runtime carries (its error links). */
const SVELTE_CLIENT_MARKER = 'svelte.dev/e/';
const RUNTIME_RE = /\/og-runtime\.[^/]+\.js$/;

test.describe('lazy runtime chunks: no Svelte client runtime at boot on a visible/interaction-only page', () => {
	test('boot fetches the runtime only; the first wake fetches the hydrate core + Svelte', async ({
		page
	}) => {
		const scripts: string[] = [];
		page.on('response', (r) => {
			if (r.request().resourceType() === 'script') scripts.push(r.url());
		});
		await page.goto('/lazy-runtime', { waitUntil: 'networkidle' });
		await page.waitForTimeout(400);
		check('runtime booted (ogygia-region defined)', await page.evaluate(() => !!customElements.get('ogygia-region')));
		check('boot: the runtime chunk was fetched', scripts.some((u) => RUNTIME_RE.test(u)), scripts.join('\n'));
		check(
			'boot: no island hydrated (visible is below the fold, interaction is cold)',
			(await page.locator('ogygia-region[data-hydrated]').count()) === 0
		);
		const boot_scripts = [...scripts];
		// Read every script fetched at boot: none may be (or import) Svelte's client runtime.
		const bodies = await Promise.all(
			boot_scripts.map(async (u) => ({ u, text: await (await fetch(u)).text() }))
		);
		const svelte_at_boot = bodies.filter((b) => b.text.includes(SVELTE_CLIENT_MARKER)).map((b) => b.u);
		check(
			`boot: no fetched script carries Svelte's client runtime (${boot_scripts.length} scripts read)`,
			svelte_at_boot.length === 0,
			svelte_at_boot.join('\n')
		);

		// The first wake: click the interaction island → hydrate core + Svelte + the island's chunk.
		await page.locator('[data-i-btn]').click();
		await page.waitForSelector('ogygia-region[wake="interaction"][data-hydrated]', { timeout: 8000 });
		await page.waitForTimeout(300);
		const after_wake = scripts.slice(boot_scripts.length);
		const wake_bodies = await Promise.all(
			after_wake.map(async (u) => ({ u, text: await (await fetch(u)).text() }))
		);
		check(
			"wake: the scripts fetched by the first wake include Svelte's client runtime",
			wake_bodies.some((b) => b.text.includes(SVELTE_CLIENT_MARKER)),
			after_wake.join('\n')
		);
		check('wake: the click replayed (count 1)', (await page.locator('[data-i-count]').innerText()) === '1');

		// The visible island below the fold wakes on scroll, from the already-loaded core.
		await page.locator('[data-counter]').scrollIntoViewIfNeeded();
		await page.waitForSelector('ogygia-region[wake="visible"][data-hydrated]', { timeout: 8000 });
		check('visible island hydrated after scroll', (await page.locator('[data-counter] button').innerText()).includes('5'));
	});
});
