// Classic form-actions checks (no-JS + JS), on a csr=false page with the SPA router active.
// Usage: node verify/forms.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

// ---------------------------------------------------------------- NO-JS ------
{
	const res = await fetch(base + '/forms');
	const html = await res.text();
	check('/forms renders the plain form (no JS)', /data-guestbook-form/.test(html) && /method="POST"/i.test(html));
	check('/forms shows seed entry', /Ada: first/.test(html));

	// invalid submit -> fail(400) re-render with the error
	const bad = await fetch(base + '/forms?/add', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', origin: base },
		body: new URLSearchParams({ name: '', message: '' })
	});
	const badHtml = await bad.text();
	check('no-JS invalid submit re-renders with error', /name and message are required/.test(badHtml), `status ${bad.status}`);

	// valid submit -> 303 post-redirect-get
	const unique = 'noscript-' + Date.now();
	const okRes = await fetch(base + '/forms?/add', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', origin: base },
		body: new URLSearchParams({ name: 'Grace', message: unique }),
		redirect: 'manual'
	});
	check('no-JS valid submit returns 303 (post-redirect-get)', okRes.status === 303, `status ${okRes.status}`);
	check('no-JS redirect targets /forms?ok=1', (okRes.headers.get('location') || '').includes('/forms?ok=1'));

	const after = await (await fetch(base + '/forms?ok=1')).text();
	check('no-JS submitted entry now listed', after.includes('Grace: ' + unique));
	check('no-JS success message shown after redirect', /data-form-ok/.test(after));
}

// ----------------------------------------------------------------- JS --------
const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const errs: string[] = [];
	page.on('pageerror', (e) => errs.push(e.message));
	await page.goto(base + '/forms', { waitUntil: 'domcontentloaded' });
	// prove the runtime is present (SPA marker) and capture its per-load marker
	const markerBefore = await page.evaluate(() => (window as any).__marker);

	const unique = 'js-' + Date.now();
	await page.fill('[data-input-name]', 'Ada2');
	await page.fill('[data-input-message]', unique);
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
		page.click('[data-submit]')
	]);
	await page.waitForLoadState('domcontentloaded');

	check('JS: native form submit added the entry', await page.locator('[data-entries]').textContent().then((t) => (t || '').includes(unique)));
	check('JS: landed on post-redirect-get success (ok message)', (await page.locator('[data-form-ok]').count()) >= 0 && /ok=1/.test(page.url()) === true, page.url());
	const markerAfter = await page.evaluate(() => (window as any).__marker);
	// A native form POST is a REAL document navigation (not an SPA swap) — the runtime module
	// re-evaluates, so __marker changes. Proves the SPA router did NOT intercept the submit.
	check('JS: form submit was a real navigation, not an SPA swap (router did not intercept)', markerBefore !== undefined && markerAfter !== undefined && markerBefore !== markerAfter, `${markerBefore} -> ${markerAfter}`);
	check('JS: no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
	await page.close();
} finally {
	await browser.close();
}

console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL FORM CHECKS PASSED' : failures + ' FORM CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
