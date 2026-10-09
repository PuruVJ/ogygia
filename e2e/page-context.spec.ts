// THE PAGE OF A RENDER (server/render-page.ts, server/page-facts.ts): a region rendered outside its
// page — a hole in the islands endpoint's request, a region a remote query or command renders in the
// remote call's request — sees the page it renders for: its url (the same-origin Referer), its route
// and params, and its `page.data`, looked up through Kit's data request for this visitor, now.
//
// REGRESSION (field report on 6b927c3c): a signed-in header a remote `query` rendered and a `command`
// refreshed came out signed out, wrong locale, wrong path: `page.data` was `{}` and `page.url` was the
// remote endpoint's.
// Usage: pnpm exec playwright test page-context
import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const facts = async (el: Locator) => ({
	who: await el.getAttribute('data-who'),
	locale: await el.getAttribute('data-locale'),
	path: await el.getAttribute('data-path'),
	route: await el.getAttribute('data-route'),
	slug: await el.getAttribute('data-slug')
});
const PAGE = { who: 'page-load', locale: 'en', path: '/page-context/alpha', route: '/page-context/[slug]', slug: 'alpha' };

test('build output: each hole’s page.data answer is patched in (a hole that reads none never looks its page up)', () => {
	// REGRESSION: a plain `null` placeholder was inlined by the bundler into every reader, so every
	// hole of every page ran its page's loads again (the freeze deck's "shell rendered once" caught it)
	const server = fileURLToPath(new URL('../apps/playground/.svelte-kit/output/server/', import.meta.url));
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (p.endsWith('.js')) files.push(p);
		}
	};
	walk(server);
	const code = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
	expect(code.includes('__OGYGIA_PAGE_DATA_READS__')).toBe(false);
	// some holes read page.data (the page-context lab's), others do not (the restore lab's)
	const map_at = code.indexOf('JSON.parse("{');
	expect(map_at).toBeGreaterThan(-1);
	const map = JSON.parse(JSON.parse(code.slice(map_at + 'JSON.parse('.length, code.indexOf('")', map_at) + 1))) as Record<string, boolean>;
	expect(Object.values(map)).toContain(true);
	expect(Object.values(map)).toContain(false);
});

test('a region a remote query renders when its island wakes sees the calling page', async ({ page }) => {
	await page.goto('/page-context/alpha');
	expect(await facts(page.locator('[data-pc="remote"]'))).toEqual(PAGE);
});

test('a hole whose tree reads page.data sees its page’s data, url, route and params', async ({ page }) => {
	await page.goto('/page-context/alpha');
	const hole = page.locator('[data-pc="hole"]');
	await expect(hole).toBeAttached({ timeout: 10_000 });
	expect(await facts(hole)).toEqual(PAGE);
});

test('a region a remote query renders on refresh sees the calling page', async ({ page }) => {
	await page.goto('/page-context/alpha');
	await page.waitForSelector('ogygia-region[data-hydrated] [data-pc-refresh]');
	const remote = page.waitForResponse((r) => r.url().includes('/_app/remote/'));
	await page.locator('[data-pc-refresh]').click();
	await remote;
	await page.waitForTimeout(300);
	expect(await facts(page.locator('[data-pc="remote"]'))).toEqual(PAGE);
});

test('a command that changes what the load reads returns a region with the new facts', async ({ page, context }) => {
	await context.clearCookies();
	await page.goto('/page-context/alpha');
	await page.waitForSelector('ogygia-region[data-hydrated] [data-pc-switch]');
	await page.locator('[data-pc-switch]').click();
	await expect(page.locator('[data-pc="remote"]')).toHaveAttribute('data-locale', 'fr', { timeout: 10_000 });
	expect(await facts(page.locator('[data-pc="remote"]'))).toEqual({ ...PAGE, locale: 'fr' });
	await context.clearCookies();
});

test('one page, not two: the islands inside the new region and on the page see the region’s facts', async ({ page, context }) => {
	await context.clearCookies();
	const errors: string[] = [];
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
	await page.goto('/page-context/alpha');
	await page.waitForSelector('ogygia-region[data-hydrated] [data-pc-switch]');
	await expect(page.locator('[data-pc-badge="page"]')).toHaveAttribute('data-locale', 'en');
	await page.locator('[data-pc-switch]').click();
	await expect(page.locator('[data-pc="remote"]')).toHaveAttribute('data-locale', 'fr', { timeout: 10_000 });
	// the island inside hydrates against the locale its HTML was rendered with, and works
	const inside = page.locator('[data-pc-badge="inside"]');
	await expect(inside.locator('xpath=ancestor::ogygia-region[1]')).toHaveAttribute('data-hydrated', '', { timeout: 10_000 });
	await inside.click();
	await expect(inside).toHaveText('fr · 1');
	expect(await page.locator('[data-og-healed],[data-og-recovered]').count()).toBe(0);
	// the page's own island reads the same key: the page's data changed, it shows the new value
	await expect(page.locator('[data-pc-badge="page"]')).toHaveAttribute('data-locale', 'fr');
	expect(errors.filter((e) => e.includes('hydrat'))).toEqual([]);
	await context.clearCookies();
});
