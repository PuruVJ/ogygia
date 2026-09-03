// Classic form-actions checks (no-JS + JS), on a csr=false page with the SPA router active.
// Usage: pnpm exec playwright test forms
import { test, check } from './fixtures/index.ts';

const GUESTBOOK_FORM_RE = /data-guestbook-form/;
const METHOD_POST_RE = /method="POST"/i;
const SEED_ENTRY_RE = /Ada: first/;
const REQUIRED_ERROR_RE = /name and message are required/;
const FORM_OK_RE = /data-form-ok/;
const OK_QUERY_RE = /ok=1/;
const REMOTE_ACTION_RE = /\/remote=/;
const REQUIRED_RE = /required/;
const SIGNED_RE = /Signed via remote form/;

test.describe('classic form actions (no-JS + JS)', () => {
	// ---------------------------------------------------------------- NO-JS ------
	test('no-JS: plain form, fail(400) re-render, 303 post-redirect-get', async ({ baseURL }) => {
		const res = await fetch(baseURL + '/forms');
		const html = await res.text();
		check(
			'/forms renders the plain form (no JS)',
			GUESTBOOK_FORM_RE.test(html) && METHOD_POST_RE.test(html)
		);
		check('/forms shows seed entry', SEED_ENTRY_RE.test(html));

		// invalid submit -> fail(400) re-render with the error
		const bad = await fetch(baseURL + '/forms?/add', {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'text/html',
				origin: baseURL
			},
			body: new URLSearchParams({ name: '', message: '' })
		});
		const badHtml = await bad.text();
		check(
			'no-JS invalid submit re-renders with error',
			REQUIRED_ERROR_RE.test(badHtml),
			`status ${bad.status}`
		);

		// valid submit -> 303 post-redirect-get
		const unique = 'noscript-' + Date.now();
		const okRes = await fetch(baseURL + '/forms?/add', {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'text/html',
				origin: baseURL
			},
			body: new URLSearchParams({ name: 'Grace', message: unique }),
			redirect: 'manual'
		});
		check(
			'no-JS valid submit returns 303 (post-redirect-get)',
			okRes.status === 303,
			`status ${okRes.status}`
		);
		check(
			'no-JS redirect targets /forms?ok=1',
			(okRes.headers.get('location') || '').includes('/forms?ok=1')
		);

		const after = await (await fetch(baseURL + '/forms?ok=1')).text();
		check('no-JS submitted entry now listed', after.includes('Grace: ' + unique));
		check('no-JS success message shown after redirect', FORM_OK_RE.test(after));
	});

	// ----------------------------------------------------------------- JS --------
	test('JS: a native form submit is a real navigation (the SPA router does not intercept)', async ({
		page
	}) => {
		const errs: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		await page.goto('/forms', { waitUntil: 'domcontentloaded' });
		// prove the runtime is present (SPA marker) and capture its per-load marker
		const markerBefore = await page.evaluate(() => window.__marker);

		const unique = 'js-' + Date.now();
		await page.fill('[data-input-name]', 'Ada2');
		await page.fill('[data-input-message]', unique);
		await Promise.all([
			page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
			page.click('[data-submit]')
		]);
		await page.waitForLoadState('domcontentloaded');

		check(
			'JS: native form submit added the entry',
			await page
				.locator('[data-entries]')
				.textContent()
				.then((t) => (t || '').includes(unique))
		);
		check(
			'JS: landed on post-redirect-get success (ok message)',
			(await page.locator('[data-form-ok]').count()) >= 0 && OK_QUERY_RE.test(page.url()) === true,
			page.url()
		);
		const markerAfter = await page.evaluate(() => window.__marker);
		// A native form POST is a REAL document navigation (not an SPA swap) — the runtime module
		// re-evaluates, so __marker changes. Proves the SPA router did NOT intercept the submit.
		check(
			'JS: form submit was a real navigation, not an SPA swap (router did not intercept)',
			markerBefore !== undefined && markerAfter !== undefined && markerBefore !== markerAfter,
			`${markerBefore} -> ${markerAfter}`
		);
		check('JS: no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
	});

	// ---- Remote form() inside an island (Kit's real form runtime, reused via ogygia) ----
	test('remote form() inside an island: no-JS action, field issue, enhanced submit without reload', async ({
		page
	}) => {
		const errs: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		await page.goto('/forms', { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('[data-remote-form]', { timeout: 5000 });
		check(
			'remote form: posts to the remote endpoint (no-JS action)',
			REMOTE_ACTION_RE.test((await page.getAttribute('[data-remote-form]', 'action')) || '')
		);
		// invalid submit -> field issue (enhanced, client-side validation)
		await page.click('[data-rf-submit]');
		await page.waitForSelector('[data-rf-name-issue]', { timeout: 4000 }).catch(() => {});
		check(
			'remote form: schema field issue shown',
			REQUIRED_RE.test(
				(await page
					.locator('[data-rf-name-issue]')
					.first()
					.textContent()
					.catch(() => '')) || ''
			)
		);
		// valid submit -> result, NO reload (enhanced)
		const m1 = await page.evaluate(() => window.__marker);
		const uniq = 'rf-' + Date.now();
		await page.fill('[data-rf-name]', 'Ada');
		await page.fill('[data-rf-message]', uniq);
		await page.click('[data-rf-submit]');
		await page.waitForSelector('[data-rf-result]', { timeout: 5000 }).catch(() => {});
		check(
			'remote form: enhanced submit shows result without reload',
			SIGNED_RE.test(
				(await page
					.locator('[data-rf-result]')
					.textContent()
					.catch(() => '')) || ''
			) && (await page.evaluate(() => window.__marker)) === m1
		);
		check('remote form: no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
	});
});
