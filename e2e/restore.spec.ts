// REVERSIBLE TRANSFORMS, end to end (ogygia.handle({ transform }), server/reversible.ts +
// runtime/restore.ts): the built playground, served with OGYGIA_RESTORE_LAB=1, runs a scoped
// web-component render (apps/playground/src/lib/restorelab/scoped-render.ts) over every document and
// region answer. On /restore-lab the island inside a reshaped host must hydrate without a heal and
// stay interactive, the parser must not split the page's link or <p> around a host's tree, the hole's
// answer must arrive restored (its island hydrating after), a server-owned host is left for its own
// runtime, and nothing of ogygia's marking is left in the DOM.
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawn_server, type SpawnedServer } from './fixtures/servers.js';

const PORT = 4186;
const base = `http://127.0.0.1:${PORT}`;
const playground = fileURLToPath(new URL('../apps/playground', import.meta.url));
let srv: SpawnedServer | null = null;

test.use({ baseURL: base });
test.beforeAll(async () => {
	// (the suite's webServer already built the playground: serve that build with the lab's transform)
	srv = await spawn_server({
		cmd: process.execPath,
		args: ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
		cwd: playground,
		env: { OGYGIA_RESTORE_LAB: '1', ORIGIN: base },
		url: `${base}/restore-lab`,
		timeout_ms: 60_000
	});
});
test.afterAll(() => srv?.kill());

test('the island inside a reshaped host hydrates as is, and stays interactive', async ({ page }) => {
	const errors: string[] = [];
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto('/restore-lab');
	const island = page.locator('ogygia-region[data-hydrated]').first();
	await expect(island).toBeAttached();
	await page.locator('[data-lab-count]').click();
	await expect(page.locator('[data-lab-count]')).toHaveText('count 1');
	const facts = await page.evaluate(() => {
		const card = document.querySelector('[data-lab-card]')!;
		return {
			healed: document.querySelectorAll('[data-og-healed],[data-og-recovered]').length,
			shadow_title: card.shadowRoot?.querySelector('b')?.textContent ?? null,
			sheets: card.shadowRoot?.adoptedStyleSheets.length ?? 0,
			host_class: card.getAttribute('class'),
			kept: card.hasAttribute('data-rendered'),
			light: card.innerHTML,
			marks: document.querySelectorAll('[og-h],[og-c],[og-u],[og-r],[og-shadow],og-as').length,
			link_whole: !!document.querySelector('a[data-lab-link] demo-link'),
			p_whole: !!document.querySelector('p[data-lab-p] demo-card[data-lab-inline]'),
			server_left: !document.querySelector('[data-server-card]')!.shadowRoot
		};
	});
	expect(facts.healed).toBe(0);
	expect(facts.shadow_title).toBe('Card title');
	expect(facts.sheets).toBe(1);
	// Svelte's class back, the renderer's kept attribute stays, the whitespace the render trimmed is back
	expect(facts.host_class).toBe('own');
	expect(facts.kept).toBe(true);
	expect(facts.light).toContain('some   text');
	expect(facts.marks).toBe(0);
	expect(facts.link_whole).toBe(true);
	expect(facts.p_whole).toBe(true);
	expect(facts.server_left).toBe(true);
	expect(errors).toEqual([]);
});

test('a hole’s answer arrives restored, and its island hydrates after', async ({ page }) => {
	await page.goto('/restore-lab');
	await expect(page.locator('[data-hole-count]')).toBeVisible();
	await page.locator('[data-hole-count]').click();
	await expect(page.locator('[data-hole-count]')).toHaveText('hole count 1');
	const hole = await page.evaluate(() => {
		const card = document.querySelector('[data-hole-card]')!;
		return {
			shadow: !!card.shadowRoot,
			sheets: card.shadowRoot?.adoptedStyleSheets.length ?? 0,
			healed: document.querySelectorAll('[data-og-healed],[data-og-recovered]').length,
			head_sheets: document.head.querySelectorAll('template[data-og-head="demo-card.shadow"]').length
		};
	});
	expect(hole).toEqual({ shadow: true, sheets: 1, healed: 0, head_sheets: 1 });
});
