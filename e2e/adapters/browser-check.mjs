// Behavior check for one booted adapter output. Usage: node browser-check.mjs <baseUrl>
// Proves the all-csr=false island actually WORKS end to end on this platform:
//   • the page is server-rendered (no Kit client bootstrap on a csr=false page),
//   • ogygia's runtime script — the one that used to 404 when Kit skipped the client build — loads,
//   • the island hydrates and is interactive (click increments),
//   • no console errors / hydration mismatches.
// Exit code is the failure count.
import { chromium } from 'playwright';

const base = (process.argv[2] || 'http://localhost:3097').replace(/\/$/, '');
// Hard watchdog: a browser check must never hang the whole suite.
const watchdog = setTimeout(() => {
	console.log('    FAIL  browser check timed out (30s watchdog)');
	process.exit(1);
}, 30000);
watchdog.unref?.();
let failures = 0;
const line = (ok, name, extra = '') => {
	if (!ok) failures++;
	console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

// The runtime + island scripts must actually serve (this is the regression the keepalive fixes).
async function status(url) {
	try {
		const r = await fetch(url);
		return r.status;
	} catch {
		return 0;
	}
}

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
	const errors = [];
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
	page.on('pageerror', (e) => errors.push(String(e)));

	const html = await (await fetch(base + '/')).text();
	line(/data-title/.test(html), 'page server-rendered (SSR HTML present)');

	// Hash charset is Vite/rolldown's: hex plus the `-`/`_` that the feature-set busting adds a second
	// segment with (e.g. `og-runtime.025962a09ea0-3d150168.js`). Keep it broad so a valid filename never
	// reads as "none".
	const rt = html.match(/\/_app\/immutable\/og-runtime\.[\w-]+\.js/)?.[0];
	line(!!rt, 'runtime script referenced in HTML', rt || 'none');
	if (rt) line((await status(base + rt)) === 200, 'runtime script serves 200 (the 404 regression)', rt);

	await page.goto(base + '/', { waitUntil: 'load', timeout: 15000 });
	const counter = page.locator('[data-counter]').first();
	await counter.waitFor({ timeout: 10000 });
	const before = (await counter.textContent())?.trim();
	line(before === 'count 10', 'island SSR text', JSON.stringify(before));

	await counter.click();
	await counter.click();
	const after = (await counter.textContent())?.trim();
	line(after === 'count 12', 'island hydrated & interactive (click increments)', JSON.stringify(after));

	line(
		!errors.some((e) => /hydrat/i.test(e)),
		'no hydration-mismatch errors',
		errors.filter((e) => /hydrat/i.test(e))[0] || ''
	);
	line(errors.length === 0, 'no console/page errors', errors[0] || '');
} catch (err) {
	line(false, 'browser check threw', String(err?.message ?? err));
} finally {
	await browser.close();
}

clearTimeout(watchdog);
process.exit(failures);
