// OBSERVATORY (browser compiler, Rung 1 v0): the ogygia mark analysis runs in the BROWSER, in a Web
// Worker — svelte/compiler parses the component, the real `with { … }` island marks are resolved to
// strategies, and the host is rewritten (marked import → virtual wrapper). Asserts: the island mounts,
// exactly ONE worker is spawned (no per-keystroke runaway), the island map resolves every strategy,
// the host rewrite lands, and a live edit updates the map off the main thread.
// Usage: node e2e/observatory.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const workers: string[] = [];
	page.on('worker', (w) => workers.push(w.url()));
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));

	await page.goto(base + '/observatory', { waitUntil: 'load' });
	await page.waitForSelector('[data-obs-map] tbody tr', { timeout: 10000 }).catch(() => {});
	await page.waitForTimeout(400);

	check('observatory island mounted', (await page.locator('[data-observatory]').count()) === 1);
	check('runs its compile in a Web Worker', workers.length >= 1, `${workers.length} worker(s)`);
	check('exactly ONE worker (no per-keystroke runaway)', workers.length === 1, `${workers.length}`);

	const strategies = await page.evaluate(() =>
		[...document.querySelectorAll('[data-obs-map] .badge')].map((b) => b.textContent)
	);
	check('island map resolves every strategy from real marks', strategies.length >= 6, JSON.stringify(strategies));
	for (const s of ['island', 'server hole', 'lake', 'held (raw)']) {
		check(`island map has a '${s}' region`, strategies.includes(s));
	}

	const out = await page.evaluate(() => document.querySelector('[data-obs-output]')?.textContent || '');
	check('host rewrite: marked import → virtual wrapper', /virtual:ogygia\/wrapper\/[0-9a-f]+/.test(out), out.slice(0, 60));

	// ── live edit: add a marked import, expect the map to grow — off the main thread ──
	const before = strategies.length;
	await page.evaluate(() => {
		const ta = document.querySelector('[data-obs-input]') as HTMLTextAreaElement;
		const next = ta.value.replace('</scr' + 'ipt>', "  import X from './X.svelte' with { wake: 'idle' };\n</scr" + 'ipt>');
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
		setter.call(ta, next);
		ta.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForTimeout(500);
	const after = await page.evaluate(() => document.querySelectorAll('[data-obs-map] .badge').length);
	check('live edit updates the island map', after === before + 1, `${before} → ${after}`);
	check('still exactly one worker after edits', workers.length === 1, `${workers.length}`);
	check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

	await page.close();
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL OBSERVATORY CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
