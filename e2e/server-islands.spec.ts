// Server-island checks (fetch + Playwright). Usage: pnpm exec playwright test server-islands
// Works against the prod build (adapter-node, ORIGIN not required — the island uses a GET
// query) and the dev server.
import { createHash } from 'node:crypto';
import { test, check } from './fixtures/index.ts';
import {
	AMP_ENTITY_G_RE,
	ENDPOINT_ATTR_RE,
	KIT_MARKER_RE,
	PRELOAD_FETCH_RE,
	REGION_DEFER_G_RE,
	VITE_CLIENT_RE,
	VITE_FS_RE,
	VITE_ID_RE
} from './fixtures/re.ts';

const REGION_WHEN_RE = /<ogygia-region\b[^>]*\bwhen="/;
const LOADING_GREETING_RE = /loading greeting/;
const HELLO_ADA_OR_STRANGER_RE = /Hello, (Ada|stranger)/;
const PRELOAD_FETCH_ANON_RE = /rel="preload" as="fetch" crossorigin="anonymous"/;
const PRELOAD_HREF_OGYGIA_RE = /href="[^"]*__ogygia__/;
const IMMUTABLE_JS_RE = /_app\/immutable\/[^"']*\.js/g;
const NODES_13_JS_RE = /nodes\/13[^"']*\.js/;
const SERVER_GREETING_CHUNK_RE = /server-greeting/;
const CACHED_ENDPOINT_ATTR_RE = /data-cached-greeting[\s\S]*?endpoint="([^"]*)"/;
const SERVER_GREETING_RE = /data-server-greeting/;
const HELLO_ADA_RE = /Hello, Ada!/;
const HELLO_GRACE_RE = /Hello, Grace!/;
const HELLO_STRANGER_RE = /Hello, stranger!/;
const XFO_DENY_RE = /DENY/i;
const FRAME_ANCESTORS_NONE_RE = /frame-ancestors\s+'none'/;
const TTL_3600_RE = /([?&])ttl=3600/;
const SIG_RE = /sig=[0-9a-f]+/;
const PROPS_RE = /props=[^&]+/;
const RENDER_STAMP_RE = /at (\S+Z)/;

const count = (s: string, re: RegExp) => (s.match(re) || []).length;
const note = (text: string) => test.info().annotations.push({ type: 'note', description: text });

// The two SSR documents are fetched once: the SSR checks read them, and every endpoint check
// drives the signed `endpoint` URLs they carry.
let server_status = 0;
let server_html = '';
let cached_html = '';
let endpoint = '';
let cachedEndpoint = '';

test.describe('defer fallback/endpoint/HMAC/cookie/CSS', () => {
	test.beforeAll(async ({ baseURL }) => {
		const res = await fetch(baseURL + '/server');
		server_status = res.status;
		server_html = await res.text();
		// ServerIsland emits a RELATIVE path (Kit's server resolve()); resolve it against the page
		// URL exactly as the browser does, giving an absolute URL for the fetch checks below.
		const m = server_html.match(ENDPOINT_ATTR_RE);
		endpoint = m ? new URL(m[1].replace(AMP_ENTITY_G_RE, '&'), baseURL + '/server').href : '';

		// The /server-cached island opts into a browser cache via `maxAge: '1h'` (preset cachedGreeting).
		const rc = await fetch(baseURL + '/server-cached');
		cached_html = await rc.text();
		const mc = cached_html.match(CACHED_ENDPOINT_ATTR_RE);
		cachedEndpoint = mc
			? new URL(mc[1].replace(AMP_ENTITY_G_RE, '&'), baseURL + '/server-cached').href
			: '';
	});

	// ---------------------------------------------------------------- fetch/SSR --
	test('SSR: one deferred hole with fallback + preload, no Kit bootstrap, no component JS', () => {
		const html = server_html;
		check('/server returns 200', server_status === 200);
		check('/server has exactly one deferred region', count(html, REGION_DEFER_G_RE) === 1);
		check('/server deferred region has a when schedule', REGION_WHEN_RE.test(html));
		check('/server fallback rendered in initial HTML', LOADING_GREETING_RE.test(html));
		check(
			'/server does NOT render the component at page-SSR (no "Hello," yet)',
			!HELLO_ADA_OR_STRANGER_RE.test(html)
		);
		check('/server preload hint present (rel=preload as=fetch)', PRELOAD_FETCH_RE.test(html));
		check(
			'/server preload uses crossorigin=anonymous (matches fetch credentials: same-origin)',
			PRELOAD_FETCH_ANON_RE.test(html)
		);
		check(
			'/server preload points at the island endpoint (raw-emoji path)',
			PRELOAD_HREF_OGYGIA_RE.test(html)
		);
		check('/server ships NO Kit bootstrap (csr=false)', !KIT_MARKER_RE.test(html));
		// The "zero component JS" guarantee is a production-build property. In dev, Vite injects
		// module URLs for HMR/tooling, so only assert this against a real build.
		const isDev = VITE_CLIENT_RE.test(html) || VITE_FS_RE.test(html) || VITE_ID_RE.test(html);
		if (!isDev) {
			check(
				'/server ships NO island component JS (only the runtime module)',
				count(html, IMMUTABLE_JS_RE) >= 1 &&
					!NODES_13_JS_RE.test(html) &&
					!SERVER_GREETING_CHUNK_RE.test(html)
			);
		} else {
			note('SKIP  /server "no component JS" check (dev build injects module URLs)');
		}

		check('/server island carries a endpoint', !!server_html.match(ENDPOINT_ATTR_RE));
		check('/server-cached island carries a endpoint', !!cached_html.match(CACHED_ENDPOINT_ATTR_RE));
	});

	// --------------------------------------------------------------- endpoint ----
	test('endpoint: a valid signed request renders + personalizes from the cookie; dynamic holes are no-store and deny framing', async () => {
		// valid signed request (from the page) + cookie -> personalized rendered HTML
		const res = await fetch(endpoint, { headers: { cookie: 'sk_name=Ada' } });
		const html = await res.text();
		check('endpoint returns 200 for a valid signed request', res.status === 200);
		check('endpoint returns rendered island HTML', SERVER_GREETING_RE.test(html));
		check(
			'endpoint personalizes from cookie (Hello, Ada!)',
			HELLO_ADA_RE.test(html),
			html.slice(0, 80)
		);
		// A deferred hole is dynamic by DEFAULT: no `maxAge` preset → no signed `ttl` in the URL → the
		// handle answers `no-store` (a reload re-renders fresh). Opting into a cache is the exception.
		check(
			'default deferred hole carries no signed ttl',
			!new URL(endpoint).searchParams.has('ttl'),
			endpoint
		);
		check(
			'default deferred hole is no-store (dynamic per request)',
			(res.headers.get('cache-control') || '') === 'no-store',
			res.headers.get('cache-control') || ''
		);
		check(
			'region response denies framing (XFO)',
			XFO_DENY_RE.test(res.headers.get('x-frame-options') || ''),
			res.headers.get('x-frame-options') || ''
		);
		check(
			'region response denies framing (CSP frame-ancestors)',
			FRAME_ANCESTORS_NONE_RE.test(res.headers.get('content-security-policy') || ''),
			res.headers.get('content-security-policy') || ''
		);

		// no cookie -> default greeting (proves the remote query read the request context)
		const res2 = await fetch(endpoint);
		const html2 = await res2.text();
		check(
			'endpoint default greeting without cookie (Hello, stranger!)',
			HELLO_STRANGER_RE.test(html2)
		);
	});

	// -------- opt-in cache path (maxAge: '1h' preset) — signed ttl + private max-age --------
	test("endpoint: the opt-in cache path (maxAge: '1h' preset) carries a signed ttl + private max-age", async () => {
		const u = new URL(cachedEndpoint);
		check(
			'cached hole carries a signed ttl=3600',
			u.searchParams.get('ttl') === '3600',
			cachedEndpoint
		);
		const rc = await fetch(cachedEndpoint);
		check('cached hole renders (200)', rc.status === 200);
		check(
			'cached hole is private, max-age=3600',
			(rc.headers.get('cache-control') || '') === 'private, max-age=3600',
			rc.headers.get('cache-control') || ''
		);
		// ttl is SIGNED: re-pointing it at a longer cache invalidates the MAC (403, not a longer cache).
		const tampered = cachedEndpoint.replace(TTL_3600_RE, '$1ttl=99999999');
		const rt = await fetch(tampered);
		check('re-pointing ttl breaks the MAC (403)', rt.status === 403, String(rt.status));
	});

	test('endpoint: salted ids; tampered / forged / replayed / expired capabilities are rejected (403, no oracle)', async ({
		baseURL
	}) => {
		// P1-ID: with OGYGIA_SECRET, live ids must differ from the unsalted md5(host::index)
		{
			const unsalted = createHash('md5')
				.update('src/routes/(spa)/server/+page.svelte::0')
				.digest('hex')
				.slice(0, 12);
			const liveId = new URL(endpoint).searchParams.get('id');
			check(
				'region id salted (not offline-computable without secret)',
				!!liveId && liveId !== unsalted,
				`live=${liveId} unsalted=${unsalted}`
			);
		}

		// tampered signature -> rejected
		const tampered = endpoint.replace(SIG_RE, 'sig=' + '0'.repeat(64));
		const resT = await fetch(tampered);
		check('tampered signature rejected (403)', resT.status === 403, `got ${resT.status}`);

		// tampered props (valid-looking but unsigned) -> rejected
		const tamperedProps = endpoint.replace(PROPS_RE, 'props=W3sibiI6OTk5fV0');
		const resP = await fetch(tamperedProps);
		check('tampered props rejected (403)', resP.status === 403, `got ${resP.status}`);

		// unknown region id with forged sig -> 403 (no existence oracle)
		const resU = await fetch(
			baseURL + '/__ogygia__?id=deadbeefdead&props=W3t9XQ&exp=9999999999&sig=' + '0'.repeat(64)
		);
		check('unknown region id rejected (403, no oracle)', resU.status === 403, `got ${resU.status}`);

		// cross-region replay: valid sig for this endpoint's props, but swapped id
		{
			const u = new URL(endpoint);
			const realId = u.searchParams.get('id');
			u.searchParams.set('id', 'deadbeefdead');
			const resX = await fetch(u.href);
			check(
				'cross-region id swap rejected (403)',
				resX.status === 403,
				`got ${resX.status} (was ${realId})`
			);
		}

		// expired capability
		{
			const u = new URL(endpoint);
			u.searchParams.set('exp', '1');
			const resE = await fetch(u.href);
			check('expired region capability rejected (403)', resE.status === 403, `got ${resE.status}`);
		}
	});

	// malformed percent-encoding on the islands path must not crash the process (SEC-05)
	test('malformed % path returns 4xx and the server stays up (SEC-05)', async ({ baseURL }) => {
		const resBad = await fetch(baseURL + '/100%');
		check(
			'malformed % path returns 4xx (no process crash)',
			resBad.status >= 400 && resBad.status < 500,
			`got ${resBad.status}`
		);
		const stillUp = await fetch(baseURL + '/server');
		check('server still up after malformed %', stillUp.status === 200);
	});

	// --------------------------------------------------------------- browser -----
	// (1) direct load: fallback -> swapped content, cookie personalization, CSS applied,
	//     and exactly ONE server render (preload is reused, no double-fetch).
	test('browser: direct load swaps fallback → personalized island, CSS applied, ONE server render', async ({
		page,
		context,
		baseURL
	}) => {
		await context.addCookies([{ name: 'sk_name', value: 'Ada', url: baseURL }]);
		const renderStamps = new Set<string>();
		page.on('response', async (r) => {
			if (!r.url().includes('__ogygia__')) return; // percent-encoded island emoji
			try {
				const t = await r.text();
				const at = (t.match(RENDER_STAMP_RE) || [])[1];
				if (at) renderStamps.add(at);
			} catch {
				/* ignore */
			}
		});

		await page.goto('/server', { waitUntil: 'domcontentloaded' });
		// fallback is present before the swap
		const hadFallback = (await page.locator('[data-fallback]').count()) === 1;
		await page
			.waitForFunction(
				() => document.querySelector('[data-server-greeting]')?.textContent.includes('Hello, Ada!'),
				{ timeout: 8000 }
			)
			.catch(() => {});
		check('browser: fallback shown in initial DOM', hadFallback);
		check(
			'browser: server island swapped in',
			(await page.locator('[data-server-greeting]').count()) === 1
		);
		check(
			'browser: fallback removed after swap',
			(await page.locator('[data-fallback]').count()) === 0
		);
		const txt = (
			await page
				.locator('[data-server-greeting]')
				.textContent()
				.catch(() => '')
		).trim();
		check('browser: cookie-personalized greeting (Hello, Ada!)', HELLO_ADA_RE.test(txt), txt);

		// CSS from the island component reached the page (via its import graph).
		const borderW = await page
			.locator(
				'[data-server-greeting] .greeting, .greeting[ data-server-greeting], [data-server-greeting]'
			)
			.first()
			.evaluate((el) => getComputedStyle(el.closest('.greeting') || el).borderTopWidth)
			.catch(() => '0px');
		check('browser: island CSS applied (2px border)', borderW === '2px', borderW);

		await page.waitForTimeout(300);
		check(
			'no double server render (preload reused, 1 render)',
			renderStamps.size === 1,
			`${renderStamps.size} renders`
		);
	});

	// (2) different cookie -> different name (real personalization, not a constant)
	test('browser: personalization varies by cookie (Hello, Grace!)', async ({
		page,
		context,
		baseURL
	}) => {
		await context.addCookies([{ name: 'sk_name', value: 'Grace', url: baseURL }]);
		await page.goto('/server', { waitUntil: 'domcontentloaded' });
		await page
			.waitForFunction(
				// in-browser: cannot hoist
				() =>
					/Hello, \w+!/.test(document.querySelector('[data-server-greeting]')?.textContent || ''),
				{ timeout: 8000 }
			)
			.catch(() => {});
		const txt = (
			await page
				.locator('[data-server-greeting]')
				.textContent()
				.catch(() => '')
		).trim();
		check(
			'browser: personalization varies by cookie (Hello, Grace!)',
			HELLO_GRACE_RE.test(txt),
			txt
		);
	});

	// (3) SPA nav to /server must swap the island once (no double-fetch on router swaps)
	test('browser: SPA nav to /server swaps the island once (no double-fetch)', async ({
		page,
		context,
		baseURL
	}) => {
		await context.addCookies([{ name: 'sk_name', value: 'Ada', url: baseURL }]);
		await page.goto('/data', { waitUntil: 'domcontentloaded' });
		await page.waitForTimeout(200);
		const renderStamps = new Set<string>();
		page.on('response', async (r) => {
			if (!r.url().includes('__ogygia__')) return; // percent-encoded island emoji
			try {
				const t = await r.text();
				const at = (t.match(RENDER_STAMP_RE) || [])[1];
				if (at) renderStamps.add(at);
			} catch {
				/* ignore */
			}
		});
		await page.click('a[href="/server"]');
		await page
			.waitForFunction(
				() => document.querySelector('[data-server-greeting]')?.textContent.includes('Hello, Ada!'),
				{ timeout: 8000 }
			)
			.catch(() => {});
		check(
			'browser: SPA nav swaps the server island',
			(await page.locator('[data-server-greeting]').count()) === 1
		);
		await page.waitForTimeout(300);
		check(
			'browser: SPA nav does not double-fetch (<=1 distinct render)',
			renderStamps.size <= 1,
			`${renderStamps.size} renders`
		);
	});
});
