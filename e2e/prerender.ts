// Prerender checks: a static page carrying a normal island + a personalized server-island hole.
// Usage: node verify/prerender.ts [baseUrl]
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

const prerenderedFile = fileURLToPath(new URL('../apps/playground/.svelte-kit/output/prerendered/pages/static.html', import.meta.url));

let isDev = false;
{
	const res = await fetch(base + '/static');
	const html = await res.text();
	isDev = /@vite\/client/.test(html) || /\/@fs\//.test(html) || /\/@id\//.test(html);

	check('/static returns 200', res.status === 200);
	check('/static counter island SSR (count is 7)', /count is 7/.test(html));
	check('/static server-island fallback present', /loading personalized greeting/.test(html));
	check('/static server-island endpoint reference present', /endpoint="[^"]*__ogygia__/.test(html));
	check('/static ships NO Kit bootstrap', !/__sveltekit/.test(html));

	if (!isDev) {
		check('static .html was actually prerendered to disk', existsSync(prerenderedFile));
		if (existsSync(prerenderedFile)) {
			const file = readFileSync(prerenderedFile, 'utf-8');
			check('prerendered file is static (counter + fallback baked in)', /count is 7/.test(file) && /loading personalized greeting/.test(file));

			// ---- real PPR: the static file's holes must outlive regionTtl ----
			// The baked capability is minted ~forever (a CDN file has no TTL); a 1h exp would strand
			// every hole an hour after deploy. Assert exp is at least a year out.
			// `&` rides as `&amp;` inside the HTML attribute.
			const exp = Number(file.match(/endpoint="[^"]*(?:&amp;|[?&])exp=(\d+)/)?.[1] ?? 0);
			const yearOut = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
			check('PPR: baked capability is long-lived (exp > 1y out)', exp > yearOut, `exp=${exp}`);
			// No preload hint in the static file — Kit's prerender crawler follows <link href>, so a
			// baked preload would make the build crawl the region endpoint itself (429s the build).
			check('PPR: prerendered file omits the fetch preload hint (crawler-safe)', !/rel="preload" as="fetch"/.test(file));
			// And the baked capability actually verifies against the running server (same build).
			const endpoint = file.match(/endpoint="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
			if (endpoint) {
				// endpoint is document-relative (`./__ogygia__?…`) — resolve like the browser would.
				const holeRes = await fetch(new URL(endpoint, base + '/'));
				check('PPR: baked capability verifies (hole endpoint 200)', holeRes.status === 200, `status=${holeRes.status}`);
			} else {
				check('PPR: baked capability verifies (hole endpoint 200)', false, 'no endpoint attr found');
			}
		}
	} else {
		out.push('SKIP  on-disk prerender checks (dev server does not prerender)');
	}
}

// ---- real PPR for the LAKE mint path: prerendered swr lake ----
// /static-lake bakes an swr lake's signed revalidate endpoint into a static file at build. The
// capability must be long-lived (same rule as server-island holes) and must verify at runtime.
if (!isDev) {
	const lakeFile = fileURLToPath(new URL('../apps/playground/.svelte-kit/output/prerendered/pages/static-lake.html', import.meta.url));
	check('PPR lake: static-lake.html prerendered to disk', existsSync(lakeFile));
	if (existsSync(lakeFile)) {
		const file = readFileSync(lakeFile, 'utf-8');
		const swrRegion = file.match(/<ogygia-region[^>]*remount="swr"[^>]*>/)?.[0] ?? '';
		check('PPR lake: swr region baked into the static file', swrRegion.length > 0);
		const exp = Number(swrRegion.match(/(?:&amp;|[?&])exp=(\d+)/)?.[1] ?? 0);
		const yearOut = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
		check('PPR lake: baked revalidate capability is long-lived (exp > 1y)', exp > yearOut, `exp=${exp}`);
		const endpoint = swrRegion.match(/endpoint="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
		if (endpoint) {
			const res = await fetch(new URL(endpoint, base + '/'));
			check('PPR lake: baked capability verifies (endpoint 200)', res.status === 200, `status=${res.status}`);
		} else {
			check('PPR lake: baked capability verifies (endpoint 200)', false, 'no endpoint attr');
		}
	}
}

// browser: normal island hydrates from the static file; server hole fills at runtime
const browser = await chromium.launch();
try {
	const ctx = await browser.newContext();
	await ctx.addCookies([{ name: 'sk_name', value: 'Ada', url: base }]);
	const page = await ctx.newPage();
	const errs: string[] = [];
	page.on('pageerror', (e) => errs.push(e.message));
	await page.goto(base + '/static', { waitUntil: 'domcontentloaded' });

	// counter island hydrates + is interactive
	await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 6000 }).catch(() => {});
	await page.click('[data-counter] button');
	check('prerendered counter island hydrates + interactive', /count is 8/.test((await page.locator('[data-counter]').textContent()) || ''));

	// server-island hole fills at runtime with personalized content
	await page.waitForFunction(() => document.querySelector('[data-server-greeting]')?.textContent?.includes('Welcome, Ada!'), { timeout: 8000 }).catch(() => {});
	check('server-island hole filled at runtime (personalized: Welcome, Ada!)', /Welcome, Ada!/.test((await page.locator('[data-server-greeting]').textContent().catch(() => '')) || ''));
	check('no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
	await ctx.close();
} finally {
	await browser.close();
}

console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PRERENDER CHECKS PASSED' : failures + ' PRERENDER CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
