// WHO OWNS EACH NODE IN <head> (runtime/session.ts). On a csr=false page an island's `<svelte:head>`
// re-renders fresh when it wakes, next to the server's copy of the same content.
//   1. ONE copy: after the wake, the island's head content is in the head once (the server's copy
//      is retired) — field: two identical JSON-LD blocks, doubled inline CSS and preloads.
//   2. A navigation never removes an island's live head node: Svelte deletes a head block by walking
//      from its first node to its last, and the router removing the last one first let that walk
//      delete the NEXT page's tags (field: description / canonical / og:* gone after a client nav).
//   3. An island kept across a navigation keeps its head content, once.
// Usage: pnpm exec playwright test head-ownership
import type { Page } from '@playwright/test';
import { test, check, stamp_document, document_stamp } from './fixtures/index.ts';

const count = (page: Page, sel: string) => page.evaluate((s) => document.head.querySelectorAll(s).length, sel);
const LD = 'script[type="application/ld+json"][data-head-island]';
const ISLAND_META = 'meta[name="head-island"]';

async function woken(page: Page, path: string) {
	await page.goto(path, { waitUntil: 'networkidle' });
	await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 10_000 });
}

test.describe('head ownership: island head content once, page tags never lost', () => {
	test('after the wake the island’s head content is in the head once, and its title wins', async ({ page }) => {
		await page.goto('/head-island', { waitUntil: 'commit' });
		await page.waitForSelector('[data-head-page="a"]');
		// the server's copy is there before the wake (crawlers and first paint get it)
		check('server copy present before the wake', (await count(page, LD)) >= 1);
		await woken(page, '/head-island');
		check('one JSON-LD block after the wake', (await count(page, LD)) === 1, String(await count(page, LD)));
		check('one island meta after the wake', (await count(page, ISLAND_META)) === 1, String(await count(page, ISLAND_META)));
		check('one title', (await count(page, 'title')) === 1, String(await count(page, 'title')));
		// the surviving copy is the island's live one: its reactive title updates
		await page.locator('[data-head-island-btn]').click();
		await page.waitForFunction(() => document.title === 'Head island 1', null, { timeout: 5000 });
		check('the island’s reactive title updates', (await page.title()) === 'Head island 1');
	});

	test('navigating away from a head-owning island keeps the next page’s head tags', async ({ page }) => {
		await woken(page, '/head-island');
		const stamp = await stamp_document(page);
		await page.locator('[data-to-b]').click();
		await page.waitForSelector('[data-head-page="b"]');
		await page.waitForTimeout(300);
		check('it was a client-side navigation', (await document_stamp(page)) === stamp);
		const description = await page.evaluate(() => document.head.querySelector('meta[name="description"]')?.getAttribute('content'));
		check('B’s description is present', description === 'page B', String(description));
		check('B’s canonical is present', (await count(page, 'link[rel="canonical"]')) === 1);
		check('B’s og:title is present', (await count(page, 'meta[property="og:title"]')) === 1);
		check('the island’s head content left with it', (await count(page, LD)) === 0 && (await count(page, ISLAND_META)) === 0);
		check('A’s description is gone', (await count(page, 'meta[name="description"]')) === 1);
	});

	test('an island kept across the navigation keeps its head content, once', async ({ page }) => {
		await woken(page, '/head-island');
		await page.locator('[data-to-c]').click();
		await page.waitForSelector('[data-head-page="c"]');
		await page.waitForTimeout(400);
		check('one JSON-LD block on C', (await count(page, LD)) === 1, String(await count(page, LD)));
		check('one island meta on C', (await count(page, ISLAND_META)) === 1, String(await count(page, ISLAND_META)));
		const description = await page.evaluate(() => document.head.querySelector('meta[name="description"]')?.getAttribute('content'));
		check('C’s description is present', description === 'page C', String(description));
	});
});
