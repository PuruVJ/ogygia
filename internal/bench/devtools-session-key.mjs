// THE RECORD TAB'S ANSWER KEY: record a session on the playground's /dt-session, use the page like
// a visitor (each planted island's problem, the decoy, a dead button), stop, and check the report
// (`window.__ogygia_session`, what the tab shows): each planted problem found and named, the decoy
// never. Against a dev server with devtools on (see devtools-answer-key.mjs).
//   node internal/bench/devtools-session-key.mjs [base=http://127.0.0.1:4183]
import { createRequire } from 'node:module';

const base = process.argv[2] ?? 'http://127.0.0.1:4183';
const { chromium } = createRequire(new URL('../../package.json', import.meta.url))('playwright');

/** finding code → text its message must carry (the island, the function, the element, the URL) */
const PLANTED = {
	'slow-interaction': ['SessionSlow', 'spin_on_click'],
	'rage-click': ['late'],
	'dead-click': ['dead'],
	'unexpected-shift': ['SessionShift'],
	'repeated-requests': ['/hell/api/session'],
	'failed-requests': ['404', 'dt-session-missing'],
	errors: ['planted: SessionThrow'],
	'dom-churn': ['SessionChurn'],
	// the server's own split (the profiler's Server-Timing): the endpoint waited on its upstream
	'server-time': ['/dt-session/api', 'hell/api/session']
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(base + '/dt-session', { waitUntil: 'load' });
await page.waitForTimeout(9000); // past the page-load sampler's 8 s (one sampler at a time)
if (!(await page.locator('[data-og-tab="record"]').count())) await page.locator('[data-og-panel-toggle]').click();
await page.locator('[data-og-tab="record"]').click();
await page.locator('[data-og-session-start]').click();
// the server window starts alongside (it may wait out a background sample): go once it is on
await page.locator('[data-og-session-server-state="on"]').waitFor({ timeout: 12_000 }).catch(() => {});
await page.waitForTimeout(300);

const click = (sel) => page.locator(sel).click();
await click('[data-ds="decoy"]');
await click('[data-ds="slow"]');
for (let i = 0; i < 3; i++) await click('[data-ds="late"]');
await click('[data-ds="dead"]');
await click('[data-ds="fetch"]');
await click('[data-ds="throw"]');
await click('[data-ds="churn"] button');
await click('[data-ds="shift"] button');
await click('[data-ds="server"]');
await page.waitForTimeout(2500);

await page.locator('[data-og-session-stop]').click();
await page.waitForTimeout(800);
const report = await page.evaluate(() => window.__ogygia_session ?? null);
const shown = await page.locator('[data-og-session-findings] li[data-code]').evaluateAll((els) => els.map((e) => e.getAttribute('data-code')));
// THE SERVER, MEANWHILE: the profiler's window over the same stretch (the Record tab's "and the server")
const window_text = await page.locator('[data-og-session-window]').innerText().catch(() => '');
// CLIENT → SERVER: the slow request, profiled on the server in one click, names what it waited on
let server_text = '';
const profile_btn = page.locator('[data-og-session-findings] li[data-code="server-time"] [data-og-session-profile]');
if (await profile_btn.count()) {
	await profile_btn.click();
	await page.locator('[data-og-session-server]').waitFor({ timeout: 90_000 }).catch(() => {});
	server_text = await page.locator('[data-og-session-server]').innerText().catch(() => '');
}
await browser.close();

let failed = false;
if (!report) {
	console.log('✗ no session report');
	process.exit(1);
}
console.log(`session: ${report.duration_ms} ms · ${report.counts.interactions} interactions · ${report.findings.length} findings`);
for (const [code, words] of Object.entries(PLANTED)) {
	const f = report.findings.find((x) => x.code === code && words.every((w) => x.message.includes(w)));
	const any = report.findings.find((x) => x.code === code);
	console.log(`${f ? '✓' : '✗'} ${code}${f ? '' : any ? ` — found, but not naming ${words.join(' + ')}: ${any.message.slice(0, 160)}` : ' — missing'}`);
	if (!f) failed = true;
}
for (const f of report.findings)
	if (f.message.includes('"decoy') && f.code !== 'islands-woke') {
		console.log(`✗ ${f.code} names the decoy: ${f.message.slice(0, 140)}`);
		failed = true;
	}
const win_ok = window_text.includes('/dt-session/api') && window_text.includes('/hell/api/session');
console.log(`${win_ok ? '✓' : '✗'} the server's own window over the session lists the requests the clicks made${win_ok ? '' : ` — ${window_text.slice(0, 160) || 'no window section'}`}`);
if (!win_ok) failed = true;
const srv_ok = server_text.includes('per render on the server') && server_text.includes('/hell/api/session');
console.log(`${srv_ok ? '✓' : '✗'} one click profiles the slow request on the server and names what it waited on${srv_ok ? '' : ` — ${server_text.slice(0, 160) || 'no answer'}`}`);
if (!srv_ok) failed = true;
// the island's part: its click caused the request, with the server's split
const isl = Object.values(report.by_island ?? {}).find((b) => b.requests.some((q) => q.url.includes('/dt-session/api')));
const q = isl?.requests.find((x) => x.url.includes('/dt-session/api'));
const isl_ok = !!q && q.server_ms !== null && (q.up ?? '').includes('/hell/api/session');
console.log(`${isl_ok ? '✓' : '✗'} the island's session part carries the request its click caused, with the server's split${isl_ok ? ` — ${Math.round(q.ms)} ms, ${Math.round(q.server_ms)} on the server (${q.up})` : ''}`);
if (!isl_ok) failed = true;
const missing_ui = report.findings.filter((f) => !shown.includes(f.code)).map((f) => f.code);
if (missing_ui.length) {
	console.log(`✗ the tab does not show: ${missing_ui.join(', ')}`);
	failed = true;
}
for (const f of report.findings) if (process.env.SK_ALL || !(f.code in PLANTED)) console.log(`  · ${f.code}: ${f.message.slice(0, 150)}`);
console.log(failed ? 'FAILED' : 'every planted problem found, the decoy quiet');
process.exit(failed ? 1 : 0);
