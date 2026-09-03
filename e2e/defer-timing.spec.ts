// Defer TIMING variants (task 3): a server-island hole fetches its HTML on a schedule —
// 'load' (immediate + preload) | 'idle' (requestIdleCallback) | 'visible' (IntersectionObserver) |
// media query — reusing the same scheduler as hydrate timing. Asserts:
//   - exactly ONE preload <link> is emitted (only 'load' preloads);
//   - 'load' / 'idle' / 'media' holes fetch + fill without scrolling;
//   - the 'visible' hole does NOT fetch until scrolled into view (network assertion), then fills.
// Usage: pnpm exec playwright test defer-timing
import { test, check, sleep } from './fixtures/index.ts';
import { SIG_PARAM_RE } from './fixtures/re.ts';

const ISLAND_FETCH_ID_RE = /[?&]id=[0-9a-f]{6,}/;
const ENDPOINT_ID_RE = /[?&]id=([0-9a-f]+)/;

const isIslandFetch = (u: string) => ISLAND_FETCH_ID_RE.test(u) && SIG_PARAM_RE.test(u);

test.describe('server-island fetch timing load/idle/visible/media', () => {
	test('load/idle/media fill without scrolling; visible fetches only after scroll', async ({
		page
	}) => {
		await page.setViewportSize({ width: 1000, height: 700 });
		const islandReqs: string[] = [];
		page.on('request', (r) => {
			if (isIslandFetch(r.url())) islandReqs.push(r.url());
		});

		await page.goto('/defer-timing', { waitUntil: 'domcontentloaded' });

		// --- preload: only the 'load' variant emits a preload hint ---
		const preloads = await page.$$eval('link[rel="preload"][as="fetch"]', (els) => els.length);
		check(
			'exactly one preload <link> (only fill:load preloads)',
			preloads === 1,
			`count=${preloads}`
		);

		// Server-island hole id per section. A STATIC deferred hole (no client module) carries `entry=""`
		// — its identity is the signed `endpoint` (`?id=<id>`), never the `entry` attr (which is the
		// hydrate-module URL, empty here). Reading `entry` would 404-warm the id on nav (see Region.svelte).
		const idOf = async (variant: string) => {
			const ep =
				(await page.getAttribute(`[data-defer="${variant}"] ogygia-region`, 'endpoint')) || '';
			return ep.match(ENDPOINT_ID_RE)?.[1] || '';
		};
		const [idLoad, idIdle, idVisible, idMedia] = await Promise.all([
			idOf('load'),
			idOf('idle'),
			idOf('visible'),
			idOf('media')
		]);
		check(
			'four distinct server-island holes present',
			new Set([idLoad, idIdle, idVisible, idMedia]).size === 4,
			`${idLoad},${idIdle},${idVisible},${idMedia}`
		);

		// --- let load / idle / media fill (no scroll) ---
		await page
			.waitForSelector('[data-defer="load"] [data-server-greeting]', { timeout: 6000 })
			.catch(() => {});
		await page
			.waitForSelector('[data-defer="idle"] [data-server-greeting]', { timeout: 6000 })
			.catch(() => {});
		await sleep(500);

		check(
			'load hole filled without scrolling',
			(await page.locator('[data-defer="load"] [data-server-greeting]').count()) > 0
		);
		check(
			'idle hole filled without scrolling (rIC)',
			(await page.locator('[data-defer="idle"] [data-server-greeting]').count()) > 0
		);
		check(
			'media hole filled on viewport match',
			(await page.locator('[data-defer="media"] [data-server-greeting]').count()) > 0
		);

		// --- the visible hole must NOT have fetched yet (below the fold) ---
		const visibleFetchedBefore = islandReqs.some((u) => u.includes('id=' + idVisible));
		check(
			'visible hole did NOT fetch before scroll (network)',
			!visibleFetchedBefore,
			islandReqs.filter((u) => u.includes('id=' + idVisible)).join(' | ') || '(none)'
		);
		check(
			'visible hole still shows its fallback before scroll',
			(await page.locator('[data-fallback-visible]').count()) > 0
		);
		check(
			'load hole DID fetch (network)',
			islandReqs.some((u) => u.includes('id=' + idLoad))
		);

		// --- scroll the visible hole into view -> it fetches + fills ---
		await page.locator('[data-defer="visible"]').scrollIntoViewIfNeeded();
		await page
			.waitForSelector('[data-defer="visible"] [data-server-greeting]', { timeout: 6000 })
			.catch(() => {});
		await sleep(300);

		check(
			'visible hole fetched AFTER scroll (network)',
			islandReqs.some((u) => u.includes('id=' + idVisible))
		);
		check(
			'visible hole filled after scroll',
			(await page.locator('[data-defer="visible"] [data-server-greeting]').count()) > 0
		);
		check(
			'visible hole fallback gone after fill',
			(await page.locator('[data-fallback-visible]').count()) === 0
		);
	});
});
