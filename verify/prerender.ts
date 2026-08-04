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

const prerenderedFile = fileURLToPath(new URL('../playground/.svelte-kit/output/prerendered/pages/static.html', import.meta.url));

let isDev = false;
{
	const res = await fetch(base + '/static');
	const html = await res.text();
	isDev = /@vite\/client/.test(html) || /\/@fs\//.test(html) || /\/@id\//.test(html);

	check('/static returns 200', res.status === 200);
	check('/static counter island SSR (count is 7)', /count is 7/.test(html));
	check('/static server-island fallback present', /loading personalized greeting/.test(html));
	check('/static server-island endpoint reference present', /data-endpoint="[^"]*\/_islands/.test(html));
	check('/static ships NO Kit bootstrap', !/__sveltekit/.test(html));

	if (!isDev) {
		check('static .html was actually prerendered to disk', existsSync(prerenderedFile));
		if (existsSync(prerenderedFile)) {
			const file = readFileSync(prerenderedFile, 'utf-8');
			check('prerendered file is static (counter + fallback baked in)', /count is 7/.test(file) && /loading personalized greeting/.test(file));
			check('prerendered file omits the preload hint (no request context at build)', !/rel="preload" as="fetch"/.test(file));
		}
	} else {
		out.push('SKIP  on-disk prerender checks (dev server does not prerender)');
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
	await page.waitForSelector('sk-island[data-hydrated]', { timeout: 6000 }).catch(() => {});
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
