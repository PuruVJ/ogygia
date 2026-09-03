// Prerender checks: a static page carrying a normal island + a personalized server-island hole.
// Usage: pnpm exec playwright test prerender
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, check } from './fixtures/index.ts';
import {
	AMP_ENTITY_G_RE,
	KIT_MARKER_RE,
	PRELOAD_FETCH_RE,
	VITE_CLIENT_RE,
	VITE_FS_RE,
	VITE_ID_RE
} from './fixtures/re.ts';

const COUNT_7_RE = /count is 7/;
const COUNT_8_RE = /count is 8/;
const LOADING_PERSONALIZED_RE = /loading personalized greeting/;
const ENDPOINT_OGYGIA_RE = /endpoint="[^"]*__ogygia__/;
const ENDPOINT_EXP_RE = /endpoint="[^"]*(?:&amp;|[?&])exp=(\d+)/;
/** A NON-EMPTY endpoint attribute (`+`) — stricter than the shared ENDPOINT_ATTR_RE (`*`). */
const ENDPOINT_ATTR_RE = /endpoint="([^"]+)"/;
const SWR_REGION_RE = /<ogygia-region[^>]*remount="swr"[^>]*>/;
const EXP_RE = /(?:&amp;|[?&])exp=(\d+)/;
const WELCOME_ADA_RE = /Welcome, Ada!/;

const prerenderedFile = fileURLToPath(
	new URL('../apps/playground/.svelte-kit/output/prerendered/pages/static.html', import.meta.url)
);
const lakeFile = fileURLToPath(
	new URL(
		'../apps/playground/.svelte-kit/output/prerendered/pages/static-lake.html',
		import.meta.url
	)
);

// The SSR document is fetched once: the fetch checks read it, and the on-disk legs need its
// dev/prod sniff (a dev server does not prerender).
let ssr_status = 0;
let ssr_html = '';
let is_dev = false;

test.describe('prerendered page + server-island hole', () => {
	test.beforeAll(async ({ baseURL }) => {
		const res = await fetch(baseURL + '/static');
		ssr_status = res.status;
		ssr_html = await res.text();
		is_dev =
			VITE_CLIENT_RE.test(ssr_html) || VITE_FS_RE.test(ssr_html) || VITE_ID_RE.test(ssr_html);
	});

	test('/static SSR: counter island + server-island fallback/endpoint, no Kit bootstrap', () => {
		const html = ssr_html;
		check('/static returns 200', ssr_status === 200);
		check('/static counter island SSR (count is 7)', COUNT_7_RE.test(html));
		check('/static server-island fallback present', LOADING_PERSONALIZED_RE.test(html));
		check('/static server-island endpoint reference present', ENDPOINT_OGYGIA_RE.test(html));
		check('/static ships NO Kit bootstrap', !KIT_MARKER_RE.test(html));
	});

	test('PPR: static.html is on disk, its baked hole capability is long-lived, crawler-safe, and verifies', async ({
		baseURL
	}) => {
		test.skip(is_dev, 'on-disk prerender checks (dev server does not prerender)');
		check('static .html was actually prerendered to disk', existsSync(prerenderedFile));
		if (existsSync(prerenderedFile)) {
			const file = readFileSync(prerenderedFile, 'utf-8');
			check(
				'prerendered file is static (counter + fallback baked in)',
				COUNT_7_RE.test(file) && LOADING_PERSONALIZED_RE.test(file)
			);

			// ---- real PPR: the static file's holes must outlive regionTtl ----
			// The baked capability is minted ~forever (a CDN file has no TTL); a 1h exp would strand
			// every hole an hour after deploy. Assert exp is at least a year out.
			// `&` rides as `&amp;` inside the HTML attribute.
			const exp = Number(file.match(ENDPOINT_EXP_RE)?.[1] ?? 0);
			const yearOut = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
			check('PPR: baked capability is long-lived (exp > 1y out)', exp > yearOut, `exp=${exp}`);
			// No preload hint in the static file — Kit's prerender crawler follows <link href>, so a
			// baked preload would make the build crawl the region endpoint itself (429s the build).
			check(
				'PPR: prerendered file omits the fetch preload hint (crawler-safe)',
				!PRELOAD_FETCH_RE.test(file)
			);
			// And the baked capability actually verifies against the running server (same build).
			const endpoint = file.match(ENDPOINT_ATTR_RE)?.[1]?.replace(AMP_ENTITY_G_RE, '&');
			if (endpoint) {
				// endpoint is document-relative (`./__ogygia__?…`) — resolve like the browser would.
				const holeRes = await fetch(new URL(endpoint, baseURL + '/'));
				check(
					'PPR: baked capability verifies (hole endpoint 200)',
					holeRes.status === 200,
					`status=${holeRes.status}`
				);
			} else {
				check(
					'PPR: baked capability verifies (hole endpoint 200)',
					false,
					'no endpoint attr found'
				);
			}
		}
	});

	// ---- real PPR for the LAKE mint path: prerendered swr lake ----
	// /static-lake bakes an swr lake's signed revalidate endpoint into a static file at build. The
	// capability must be long-lived (same rule as server-island holes) and must verify at runtime.
	test('PPR lake: static-lake.html bakes a long-lived swr revalidate capability that verifies', async ({
		baseURL
	}) => {
		test.skip(is_dev, 'on-disk prerender checks (dev server does not prerender)');
		check('PPR lake: static-lake.html prerendered to disk', existsSync(lakeFile));
		if (existsSync(lakeFile)) {
			const file = readFileSync(lakeFile, 'utf-8');
			const swrRegion = file.match(SWR_REGION_RE)?.[0] ?? '';
			check('PPR lake: swr region baked into the static file', swrRegion.length > 0);
			const exp = Number(swrRegion.match(EXP_RE)?.[1] ?? 0);
			const yearOut = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
			check(
				'PPR lake: baked revalidate capability is long-lived (exp > 1y)',
				exp > yearOut,
				`exp=${exp}`
			);
			const endpoint = swrRegion.match(ENDPOINT_ATTR_RE)?.[1]?.replace(AMP_ENTITY_G_RE, '&');
			if (endpoint) {
				const res = await fetch(new URL(endpoint, baseURL + '/'));
				check(
					'PPR lake: baked capability verifies (endpoint 200)',
					res.status === 200,
					`status=${res.status}`
				);
			} else {
				check('PPR lake: baked capability verifies (endpoint 200)', false, 'no endpoint attr');
			}
		}
	});

	// browser: normal island hydrates from the static file; server hole fills at runtime
	test('browser: the counter island hydrates from the static file; the server hole fills at runtime', async ({
		page,
		context,
		baseURL
	}) => {
		await context.addCookies([{ name: 'sk_name', value: 'Ada', url: baseURL }]);
		const errs: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		await page.goto('/static', { waitUntil: 'domcontentloaded' });

		// counter island hydrates + is interactive
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 6000 }).catch(() => {});
		await page.click('[data-counter] button');
		check(
			'prerendered counter island hydrates + interactive',
			COUNT_8_RE.test((await page.locator('[data-counter]').textContent()) || '')
		);

		// server-island hole fills at runtime with personalized content
		await page
			.waitForFunction(
				() =>
					document.querySelector('[data-server-greeting]')?.textContent?.includes('Welcome, Ada!'),
				{ timeout: 8000 }
			)
			.catch(() => {});
		check(
			'server-island hole filled at runtime (personalized: Welcome, Ada!)',
			WELCOME_ADA_RE.test(
				(await page
					.locator('[data-server-greeting]')
					.textContent()
					.catch(() => '')) || ''
			)
		);
		check('no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
	});
});
