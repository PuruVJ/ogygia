// Server-island checks (fetch + Playwright). Usage: node verify/server-islands.mjs [baseUrl]
// Works against the prod build (adapter-node, ORIGIN not required — the island uses a GET
// query) and the dev server.
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out = [];
function check(name, cond, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const count = (s, re) => (s.match(re) || []).length;

// ---------------------------------------------------------------- fetch/SSR --
let endpoint;
let cachedEndpoint;
{
	const res = await fetch(base + '/server');
	const html = await res.text();
	check('/server returns 200', res.status === 200);
	check('/server has exactly one deferred region', count(html, /<ogygia-region\b[^>]*\brender="defer"/g) === 1);
	check('/server deferred region has a when schedule', /<ogygia-region\b[^>]*\bwhen="/.test(html));
	check('/server fallback rendered in initial HTML', /loading greeting/.test(html));
	check(
		'/server does NOT render the component at page-SSR (no "Hello," yet)',
		!/Hello, (Ada|stranger)/.test(html)
	);
	check('/server preload hint present (rel=preload as=fetch)', /rel="preload" as="fetch"/.test(html));
	check(
		'/server preload uses crossorigin=anonymous (matches fetch credentials: same-origin)',
		/rel="preload" as="fetch" crossorigin="anonymous"/.test(html)
	);
	check('/server preload points at the island endpoint (raw-emoji path)', /href="[^"]*🏝️/.test(html));
	check('/server ships NO Kit bootstrap (csr=false)', !/__sveltekit/.test(html));
	// The "zero component JS" guarantee is a production-build property. In dev, Vite injects
	// module URLs for HMR/tooling, so only assert this against a real build.
	const isDev = /@vite\/client/.test(html) || /\/@fs\//.test(html) || /\/@id\//.test(html);
	if (!isDev) {
		check(
			'/server ships NO island component JS (only the runtime module)',
			count(html, /_app\/immutable\/[^"']*\.js/g) >= 1 &&
				!/nodes\/13[^"']*\.js/.test(html) &&
				!/server-greeting/.test(html)
		);
	} else {
		out.push('SKIP  /server "no component JS" check (dev build injects module URLs)');
	}

	const m = html.match(/endpoint="([^"]*)"/);
	check('/server island carries a endpoint', !!m);
	// ServerIsland emits a RELATIVE path (Kit's server resolve()); resolve it against the page
	// URL exactly as the browser does, giving an absolute URL for the fetch checks below.
	endpoint = m ? new URL(m[1].replace(/&amp;/g, '&'), base + '/server').href : '';
}

// The /server-cached island opts into a browser cache via `maxAge: '1h'` (preset cachedGreeting).
{
	const res = await fetch(base + '/server-cached');
	const html = await res.text();
	const mc = html.match(/data-cached-greeting[\s\S]*?endpoint="([^"]*)"/);
	check('/server-cached island carries a endpoint', !!mc);
	cachedEndpoint = mc ? new URL(mc[1].replace(/&amp;/g, '&'), base + '/server-cached').href : '';
}

// --------------------------------------------------------------- endpoint ----
{
	// valid signed request (from the page) + cookie -> personalized rendered HTML
	const res = await fetch(endpoint, { headers: { cookie: 'sk_name=Ada' } });
	const html = await res.text();
	check('endpoint returns 200 for a valid signed request', res.status === 200);
	check('endpoint returns rendered island HTML', /data-server-greeting/.test(html));
	check('endpoint personalizes from cookie (Hello, Ada!)', /Hello, Ada!/.test(html), html.slice(0, 80));
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
		/DENY/i.test(res.headers.get('x-frame-options') || ''),
		res.headers.get('x-frame-options') || ''
	);
	check(
		'region response denies framing (CSP frame-ancestors)',
		/frame-ancestors\s+'none'/.test(res.headers.get('content-security-policy') || ''),
		res.headers.get('content-security-policy') || ''
	);

	// -------- opt-in cache path (maxAge: '1h' preset) — signed ttl + private max-age --------
	{
		const u = new URL(cachedEndpoint);
		check('cached hole carries a signed ttl=3600', u.searchParams.get('ttl') === '3600', cachedEndpoint);
		const rc = await fetch(cachedEndpoint);
		check('cached hole renders (200)', rc.status === 200);
		check(
			'cached hole is private, max-age=3600',
			(rc.headers.get('cache-control') || '') === 'private, max-age=3600',
			rc.headers.get('cache-control') || ''
		);
		// ttl is SIGNED: re-pointing it at a longer cache invalidates the MAC (403, not a longer cache).
		const tampered = cachedEndpoint.replace(/([?&])ttl=3600/, '$1ttl=99999999');
		const rt = await fetch(tampered);
		check('re-pointing ttl breaks the MAC (403)', rt.status === 403, String(rt.status));
	}

	// P1-ID: with OGYGIA_SECRET, live ids must differ from the unsalted md5(host::index)
	{
		const { createHash } = await import('node:crypto');
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

	// no cookie -> default greeting (proves the remote query read the request context)
	const res2 = await fetch(endpoint);
	const html2 = await res2.text();
	check('endpoint default greeting without cookie (Hello, stranger!)', /Hello, stranger!/.test(html2));

	// tampered signature -> rejected
	const tampered = endpoint.replace(/sig=[0-9a-f]+/, 'sig=' + '0'.repeat(64));
	const resT = await fetch(tampered);
	check('tampered signature rejected (403)', resT.status === 403, `got ${resT.status}`);

	// tampered props (valid-looking but unsigned) -> rejected
	const tamperedProps = endpoint.replace(/props=[^&]+/, 'props=W3sibiI6OTk5fV0');
	const resP = await fetch(tamperedProps);
	check('tampered props rejected (403)', resP.status === 403, `got ${resP.status}`);

	// unknown region id with forged sig -> 403 (no existence oracle)
	const resU = await fetch(base + '/🏝️?id=deadbeefdead&props=W3t9XQ&exp=9999999999&sig=' + '0'.repeat(64));
	check('unknown region id rejected (403, no oracle)', resU.status === 403, `got ${resU.status}`);

	// cross-region replay: valid sig for this endpoint's props, but swapped id
	{
		const u = new URL(endpoint);
		const realId = u.searchParams.get('id');
		u.searchParams.set('id', 'deadbeefdead');
		const resX = await fetch(u.href);
		check('cross-region id swap rejected (403)', resX.status === 403, `got ${resX.status} (was ${realId})`);
	}

	// expired capability
	{
		const u = new URL(endpoint);
		u.searchParams.set('exp', '1');
		const resE = await fetch(u.href);
		check('expired region capability rejected (403)', resE.status === 403, `got ${resE.status}`);
	}

	// malformed percent-encoding on the islands path must not crash the process (SEC-05)
	{
		const resBad = await fetch(base + '/100%');
		check('malformed % path returns 4xx (no process crash)', resBad.status >= 400 && resBad.status < 500, `got ${resBad.status}`);
		const stillUp = await fetch(base + '/server');
		check('server still up after malformed %', stillUp.status === 200);
	}
}

// --------------------------------------------------------------- browser -----
const browser = await chromium.launch();
try {
	// (1) direct load: fallback -> swapped content, cookie personalization, CSS applied,
	//     and exactly ONE server render (preload is reused, no double-fetch).
	{
		const ctx = await browser.newContext();
		await ctx.addCookies([{ name: 'sk_name', value: 'Ada', url: base }]);
		const page = await ctx.newPage();
		const renderStamps = new Set();
		page.on('response', async (r) => {
			if (!r.url().includes('%F0%9F%8F%9D')) return; // percent-encoded island emoji
			try {
				const t = await r.text();
				const at = (t.match(/at (\S+Z)/) || [])[1];
				if (at) renderStamps.add(at);
			} catch {
				/* ignore */
			}
		});

		await page.goto(base + '/server', { waitUntil: 'domcontentloaded' });
		// fallback is present before the swap
		const hadFallback = (await page.locator('[data-fallback]').count()) === 1;
		await page
			.waitForFunction(
				() => document.querySelector('[data-server-greeting]')?.textContent.includes('Hello, Ada!'),
				{ timeout: 8000 }
			)
			.catch(() => {});
		check('browser: fallback shown in initial DOM', hadFallback);
		check('browser: server island swapped in', (await page.locator('[data-server-greeting]').count()) === 1);
		check('browser: fallback removed after swap', (await page.locator('[data-fallback]').count()) === 0);
		const txt = (await page.locator('[data-server-greeting]').textContent().catch(() => '')).trim();
		check('browser: cookie-personalized greeting (Hello, Ada!)', /Hello, Ada!/.test(txt), txt);

		// CSS from the island component reached the page (via its import graph).
		const borderW = await page
			.locator('[data-server-greeting] .greeting, .greeting[ data-server-greeting], [data-server-greeting]')
			.first()
			.evaluate((el) => getComputedStyle(el.closest('.greeting') || el).borderTopWidth)
			.catch(() => '0px');
		check('browser: island CSS applied (2px border)', borderW === '2px', borderW);

		await page.waitForTimeout(300);
		check('no double server render (preload reused, 1 render)', renderStamps.size === 1, `${renderStamps.size} renders`);
		await ctx.close();
	}

	// (2) different cookie -> different name (real personalization, not a constant)
	{
		const ctx = await browser.newContext();
		await ctx.addCookies([{ name: 'sk_name', value: 'Grace', url: base }]);
		const page = await ctx.newPage();
		await page.goto(base + '/server', { waitUntil: 'domcontentloaded' });
		await page
			.waitForFunction(
				() => /Hello, \w+!/.test(document.querySelector('[data-server-greeting]')?.textContent || ''),
				{ timeout: 8000 }
			)
			.catch(() => {});
		const txt = (await page.locator('[data-server-greeting]').textContent().catch(() => '')).trim();
		check('browser: personalization varies by cookie (Hello, Grace!)', /Hello, Grace!/.test(txt), txt);
		await ctx.close();
	}

	// (3) SPA nav to /server must swap the island once (no double-fetch on router swaps)
	{
		const ctx = await browser.newContext();
		await ctx.addCookies([{ name: 'sk_name', value: 'Ada', url: base }]);
		const page = await ctx.newPage();
		await page.goto(base + '/data', { waitUntil: 'domcontentloaded' });
		await page.waitForTimeout(200);
		const renderStamps = new Set();
		page.on('response', async (r) => {
			if (!r.url().includes('%F0%9F%8F%9D')) return; // percent-encoded island emoji
			try {
				const t = await r.text();
				const at = (t.match(/at (\S+Z)/) || [])[1];
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
		check('browser: SPA nav swaps the server island', (await page.locator('[data-server-greeting]').count()) === 1);
		await page.waitForTimeout(300);
		check('browser: SPA nav does not double-fetch (<=1 distinct render)', renderStamps.size <= 1, `${renderStamps.size} renders`);
		await ctx.close();
	}
} finally {
	await browser.close();
}

console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL SERVER-ISLAND CHECKS PASSED' : failures + ' SERVER-ISLAND CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
