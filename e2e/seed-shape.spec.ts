// SEED SHAPING: the page seed ships only the `page.data` keys the page's islands read. The build
// analyses each island's chunk closure (AST, binding-resolved) for `page.data.<key>` reads; the
// handle unions the asks per request and cuts `page.data` to them. A load returning 300 KB the
// islands never touch no longer ships it — a CMS home page went from 368 KB of seed to the three
// keys its islands read. Doubt goes to all: an island that hands `page.data` to a function ships
// everything, as before.
//
//   pnpm exec playwright test seed-shape
import { test, check } from './fixtures/index.ts';

const SEED_RE = /<script type="application\/ogygia-page" data-ogygia-page[^>]*>([^<]*)<\/script>/;

test('the reader page ships `small`, not the 300 KB `big`', async ({ page, baseURL }) => {
	const html = await (await fetch(baseURL + '/seed-shape')).text();
	const m = SEED_RE.exec(html);
	check('seed present (an island reads $page)', m !== null);
	const seed = m?.[1] ?? '';
	check('seed carries small', seed.includes('hello-shaped'));
	check('seed does NOT carry big', !seed.includes('BBBBBBBBBB'));
	check('seed is small', seed.length < 2000, String(seed.length));
	check('the server render still saw big (shaping is the seed only)', html.includes('server sees big: 300000'));
	const errs: string[] = [];
	page.on('pageerror', (e) => errs.push(e.message));
	await page.goto('/seed-shape', { waitUntil: 'networkidle' });
	await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 8000 }).catch(() => {});
	check('island reads its key after hydration', (await page.locator('[data-small]').textContent()) === 'hello-shaped');
	check('island reads page.url after hydration', (await page.locator('[data-path]').textContent()) === '/seed-shape');
	const btn = page.locator('[data-n]');
	await btn.click();
	check('island interactive', (await btn.textContent())!.includes('n:1'));
	check('no page errors', errs.length === 0, errs.join(' | '));
});

test('the control page (page.data handed to a helper) ships everything', async ({ page, baseURL }) => {
	const html = await (await fetch(baseURL + '/seed-shape/all')).text();
	const m = SEED_RE.exec(html);
	check('seed present', m !== null);
	check('seed carries big (doubt goes to all)', (m?.[1] ?? '').includes('BBBBBBBBBB'));
	await page.goto('/seed-shape/all', { waitUntil: 'networkidle' });
	await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 8000 }).catch(() => {});
	check('island still reads small', (await page.locator('[data-seed-shape-all] [data-small]').textContent()) === 'hello-shaped');
	check('island reads big through the helper', (await page.locator('[data-big-len]').textContent()) === '300000');
});
