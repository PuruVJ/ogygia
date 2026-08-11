// Frame-store checks (Playwright). Usage: node verify/frame-dedupe.ts [baseUrl]
//
// Proves the two headline properties of the frames architecture at runtime:
//   1. dedupe   — three identical server islands (same call → same endpoint → same address) fetch
//                 the region endpoint EXACTLY ONCE; all three still render.
//   2. no-clobber — the shared response fans out to every twin (all show the real content).
//
// The staleness/version discipline is covered deterministically in test/frame-store.test.ts.
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out: string[] = [];
const check = (name: string, cond: boolean, extra = '') => {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const browser = await chromium.launch();
try {
	const page = await browser.newPage();

	// Count requests to the region endpoint (the 🏝️ path, encoded or literal).
	const endpointHits: string[] = [];
	page.on('request', (req) => {
		const u = req.url();
		if (/\/(?:%F0%9F%8F%9D|🏝)/.test(u) || /\/_islands\b/.test(u)) endpointHits.push(u);
	});

	await page.goto(base + '/defer-twins', { waitUntil: 'load' });

	// SSR: three deferred regions, all sharing ONE endpoint (same sig).
	const html = await page.content();
	const eps = [...html.matchAll(/<ogygia-region\b[^>]*\bendpoint="([^"]+)"/g)].map((m) => m[1]);
	check('three deferred twins in SSR', eps.length === 3, `got ${eps.length}`);
	check('all three share one endpoint (same call)', new Set(eps).size === 1, `${new Set(eps).size} distinct`);

	// Wait for all three to swap in.
	await page.waitForFunction(
		() => document.querySelectorAll('ogygia-region[data-hydrated]').length >= 3,
		{ timeout: 10000 }
	).catch(() => {});

	const rendered = await page.locator('ogygia-region strong').count();
	check('all three twins rendered the component', rendered === 3, `rendered ${rendered}`);
	const fallbacksGone = await page.locator('[data-fallback]').count();
	check('fallbacks all replaced', fallbacksGone === 0, `${fallbacksGone} left`);

	// The whole point: one fetch for three identical calls.
	check('endpoint fetched EXACTLY once (dedupe)', endpointHits.length === 1, `${endpointHits.length} hits`);
} catch (err) {
	check('frame-dedupe threw', false, String((err as Error)?.message ?? err));
} finally {
	await browser.close();
}

console.log(out.join('\n'));
process.exit(failures);
