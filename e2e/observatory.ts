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
	// >= 1: our compile worker, plus the WASI helper threads rolldown-browser's WASM spawns for oxc.
	check('runs its compile in a Web Worker', workers.length >= 1, `${workers.length} worker(s) incl. WASI threads`);

	// ── EXECUTION first: the DEFAULT (multi-file demo) renders its REAL components (no stubs) ──
	const rendered = await page.evaluate(() => {
		const el = document.querySelector('[data-obs-preview]');
		return el ? { text: (el.textContent || '').trim(), stubs: el.querySelectorAll('[data-og-stub]').length } : null;
	});
	check('the multi-file app RENDERS its real components in-browser', !!rendered && /count is 3/.test(rendered.text) && rendered.stubs === 0, JSON.stringify(rendered));
	const fileTabs = await page.evaluate(() => document.querySelectorAll('[data-obs-filetabs] .filetab').length);
	check('multi-file editor shows file tabs', fileTabs >= 4, `${fileTabs} tabs`);

	// ── switch to the "all strategies" preset to exercise every island kind in the transform ──
	await page.evaluate(() => {
		const btn = [...document.querySelectorAll('[data-obs-presets] button')].find((b) => b.textContent === 'all strategies');
		(btn as HTMLElement)?.click();
	});
	await page.waitForTimeout(600);

	const strategies = await page.evaluate(() =>
		[...document.querySelectorAll('[data-obs-map] .badge')].map((b) => b.textContent)
	);
	check('island map resolves every strategy from real marks', strategies.length >= 6, JSON.stringify(strategies));
	for (const s of ['island', 'server hole', 'lake', 'held (raw)']) {
		check(`island map has a '${s}' region`, strategies.includes(s));
	}

	const out = await page.evaluate(() => document.querySelector('[data-obs-output]')?.textContent || '');
	// The REAL transform rewrites marked imports to virtual island/wrapper ids (real md5).
	check('host rewrite: marked import → virtual island/wrapper', /virtual:ogygia\/(island|region|wrapper)\/[0-9a-f]+/.test(out), out.slice(0, 80));

	// ── THE BIG ONE: the real ogygia transformHost ran in the browser ──
	const realBadge = await page.evaluate(() => document.querySelector('[data-obs-real]')?.textContent || '');
	check('the REAL ogygia transform runs in-browser (not the mark-reader)', /real ogygia transform/.test(realBadge), realBadge);
	const realIds = await page.evaluate(() => document.querySelectorAll('.realdot').length);
	check('island map shows REAL md5 region ids from the transform', realIds > 0, `${realIds} real ids`);

	// ── live edit: add a marked import, expect the map to grow — off the main thread ──
	const before = strategies.length;
	const workersBeforeEdit = workers.length; // WASI threads already spawned; edits must not add more
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
	check('worker count stable across edits (no per-keystroke runaway)', workers.length === workersBeforeEdit, `${workersBeforeEdit} → ${workers.length}`);
	// The real oxc parser (rolldown-browser WASM) parsed in-browser — the browser-compiler unlock.
	const oxcOk = await page.evaluate(() => document.querySelector('[data-obs-oxc]')?.classList.contains('ok'));
	check('real oxc parser (rolldown-browser WASM) parses in-browser', !!oxcOk);
	check('page is cross-origin isolated (COOP/COEP for the WASM)', await page.evaluate(() => self.crossOriginIsolated));
	check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

	await page.close();
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL OBSERVATORY CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
