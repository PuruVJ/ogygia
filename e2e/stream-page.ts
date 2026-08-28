// STREAMED PAGES (`page(async function* ...)`): the first yield flushes immediately, later
// yields ride the SAME response as inert <template data-og-late> chunks, and the inline boot
// swaps each into its og-late-slot as it parses. Islands inside a late chunk are custom
// elements — they wake on adoption with zero orchestration.
// Usage: node e2e/stream-page.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}

// 1) WIRE truth: the raw response carries skeleton BEFORE payload, payload inside a template
{
	const raw = await (await fetch(base + '/rtr/stream')).text();
	const i_skel = raw.indexOf('data-stream-skeleton');
	const i_tpl = raw.indexOf('<template data-og-late');
	const i_payload = raw.indexOf('data-stream-payload');
	check('wire: skeleton present in the flushed part', i_skel > -1);
	check('wire: late chunk is an inert template', i_tpl > -1);
	check('wire: payload arrives AFTER the skeleton (streamed order)', i_payload > i_tpl && i_tpl > i_skel);
	check('wire: boot script present once', raw.split('data-og-late-boot').length === 2);
	check('wire: slot wrapper present', raw.includes('og-late-slot'));
}

// 2) TIMING truth: the first chunk does NOT wait for the slow yield. Assert the DELTA on one
// response — first-chunk time vs full-body time — so server/machine jitter can't flake it:
// the full body includes the 150ms upstream sleep, the flushed part must not.
{
	const t0 = performance.now();
	// identity: a compressing middleware (vite preview, some CDNs) buffers while it gzips,
	// which would collapse the very timing this section proves — measure the raw stream
	const res = await fetch(base + '/rtr/stream', { headers: { 'accept-encoding': 'identity' } });
	const reader = res.body!.getReader();
	const chunks: string[] = [];
	const dec = new TextDecoder();
	let t_first = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!t_first) t_first = performance.now() - t0;
		chunks.push(dec.decode(value, { stream: true }));
	}
	const t_full = performance.now() - t0;
	check('timing: first chunk holds the skeleton', chunks[0]?.includes('data-stream-skeleton'));
	check(
		'timing: first chunk beat the full body by ~the upstream sleep',
		t_full - t_first >= 100,
		`first ${t_first.toFixed(0)}ms, full ${t_full.toFixed(0)}ms`
	);
}

// 3) BROWSER truth: payload swapped in, template consumed, the LATE island is interactive
const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push('console: ' + m.text());
	});
	await page.goto(base + '/rtr/stream', { waitUntil: 'networkidle' });
	await page.waitForTimeout(400);
	check('browser: payload swapped into the slot', (await page.locator('[data-stream-payload]').count()) === 1);
	check('browser: skeleton gone', (await page.locator('[data-stream-skeleton]').count()) === 0);
	check('browser: template consumed', (await page.locator('template[data-og-late]').count()) === 0);
	const btn = page.locator('[data-stream-island]');
	await btn.click();
	await page.waitForTimeout(80);
	check('browser: LATE island woke + counts', /1/.test(await btn.innerText()), await btn.innerText());

	// 4) SPA-swap twin: navigate away and back — the runtime applies templates post-swap
	await page.goto(base + '/rtr/', { waitUntil: 'networkidle' });
	await page.click('a[href*="/rtr/stream"]').catch(() => page.goto(base + '/rtr/stream'));
	await page.waitForTimeout(700);
	check('SPA: payload present after client-side nav', (await page.locator('[data-stream-payload]').count()) === 1);
	check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL STREAM CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
