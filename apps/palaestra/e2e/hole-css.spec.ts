// HOLE CSS THROUGH PACKAGES AND BARRELS (/hole-css). A server-only hole renders, on the server, a kit
// component taken by name from a workspace package whose `exports` point at a TypeScript barrel
// (internal/repro-hole-css-kit) and one from a local barrel; it holds an island whose flyout renders
// only after a click, with more components from both barrels.
// REGRESSION (field report): the flyout arrived unstyled. The hole's own sheet came from a walk that
// could not resolve a package specifier and stopped at a `.ts` module, and the island's exact chunk
// CSS was written into the hole render's head, which the endpoint never shipped.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test, expect, check } from '@ogygia/tooling/e2e';

const assets = fileURLToPath(
	new URL('../.svelte-kit/output/client/_app/immutable/assets/', import.meta.url)
);

test.describe('hole css through a workspace package barrel and a local barrel', () => {
	test('the hole’s sheet carries the components its tree takes, and none of the rest', () => {
		const sheets = readdirSync(assets).filter(
			(f) => f.startsWith('og-hole.') && f.endsWith('.css')
		);
		const sheet = sheets
			.map((f) => readFileSync(join(assets, f), 'utf8'))
			.find((css) => css.includes('account-hole'));
		check('the hole has its own sheet', !!sheet);
		for (const cls of [
			'kit-heading',
			'local-title',
			'hole-menu',
			'kit-panel',
			'kit-footer',
			'local-badge'
		])
			check(`it carries .${cls}`, sheet?.includes(cls), cls);
		check(
			'not the barrels’ other components',
			!sheet?.includes('kit-unused') && !sheet?.includes('local-unused')
		);
	});

	test('the server-rendered kit parts and the click-only flyout are styled', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto('/hole-css');
		await expect(page.locator('[data-account-hole]')).toHaveCount(1);
		const style = (sel: string, prop: string) =>
			page.locator(sel).evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
		check(
			'kit heading (package barrel, server render)',
			(await style('[data-kit-heading]', 'text-indent')) === '7px'
		);
		check(
			'local title (local barrel, server render)',
			(await style('[data-local-title]', 'text-indent')) === '9px'
		);
		// the island is live, then its flyout opens
		await expect(page.locator('ogygia-region[data-hydrated] [data-hole-menu]')).toHaveCount(1);
		await page.click('[data-hole-menu-toggle]');
		await expect(page.locator('[data-hole-flyout]')).toHaveCount(1);
		check('kit panel in the flyout', (await style('[data-kit-panel]', 'letter-spacing')) === '3px');
		check('kit footer in the flyout', (await style('[data-kit-footer]', 'display')) === 'flex');
		check(
			'local badge in the flyout',
			(await style('[data-local-badge]', 'word-spacing')) === '4px'
		);
		// the island's own chunk sheet rode the hole's answer into the head
		const region_sheets = await page.evaluate(
			() => [...document.querySelectorAll('head [data-ogygia-region-css]')].length
		);
		check(
			'the island’s chunk sheet reached the head with the hole’s',
			region_sheets >= 2,
			String(region_sheets)
		);
		const unused = await page.evaluate(() =>
			[...document.styleSheets].some((s) => {
				try {
					return [...s.cssRules].some(
						(r) => r.cssText.includes('kit-unused') || r.cssText.includes('local-unused')
					);
				} catch {
					return false;
				}
			})
		);
		check('no unused component’s CSS on the page', !unused);
		check('no page errors', errors.length === 0, errors.join(' | '));
	});
});
