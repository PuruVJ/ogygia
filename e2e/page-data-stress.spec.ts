// Adversarial streaming: hammer $page.data promise streaming from directions the happy path misses —
// a REJECTED promise (`{#await …:catch}`), a promise resolving to a value with a NESTED promise
// (recursive deferral, ids continue past the initial set), 12 staggered promises (scale + completion
// order), and a falsy resolution. Plus the NON-NAVIGATE settle path: a programmatic fetch can't run
// streamed scripts, so promises are awaited server-side and revived as settled Promises — and a
// REJECTION there must NOT 500 the render.
// Usage: pnpm exec playwright test page-data-stress
import http from 'node:http';
import https from 'node:https';
import { test, check } from './fixtures/index.ts';

const PAGE_SEED_RE = /application\/ogygia-page[^>]*>([\s\S]*?)<\/script>/;
const BOOM_REJECT_RE = /BOOM-REJECT/;
const INNER_DEEP_RE = /INNER-DEEP/;

function raw(url: string, headers: Record<string, string>) {
	const lib = url.startsWith('https') ? https : http;
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = lib.get(url, { headers }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (c: string) => (body += c));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
			res.on('error', reject);
		});
		req.on('error', reject);
	});
}

test.describe('ADVERSARIAL streaming: rejection/:catch, nested-promise recursion, 12 staggered, non-navigate settle no-crash', () => {
	// ── non-navigate SETTLE path (SPA/router): must not crash on a rejection, uses SETTLED markers ──────
	test('settle path: no crash on a rejected load promise, SETTLED markers, no streaming bootstrap', async ({
		baseURL
	}) => {
		const { status, body } = await raw(baseURL + '/page-data-stress', { accept: 'text/html' }); // no Sec-Fetch-Mode
		check(
			'settle path: render did NOT crash on a rejected load promise',
			status === 200,
			`status=${status}`
		);
		const seed = body.match(PAGE_SEED_RE)?.[1] ?? '';
		check(
			'settle path: seed uses SETTLED markers (awaited server-side), not streaming markers',
			seed.includes('OgygiaSettled') && !seed.includes('OgygiaDefer')
		);
		check(
			'settle path: NO streaming bootstrap emitted',
			!body.includes('__ogygia_page_resolve=function')
		);
		check(
			'settle path: resolved values are in the seed (incl. nested + rejection message)',
			seed.includes('INNER-DEEP') && seed.includes('BOOM-REJECT')
		);
	});

	// ── navigate STREAMING path in a real browser ──────────────────────────────────────────────────────
	test('streaming path: :catch, nested, 12 staggered, falsy, custom transport types — zero errors', async ({
		page
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push('console: ' + m.text());
		});
		await page.goto('/page-data-stress', { waitUntil: 'networkidle' });
		await page.waitForTimeout(250);

		const rej = page.locator('[data-stress-rejects]');
		check(
			'rejected promise → island shows :catch with the error',
			(await rej.getAttribute('data-stress-rejects')) === 'catch' &&
				BOOM_REJECT_RE.test(await rej.innerText())
		);

		check(
			'nested: outer promise resolved',
			(await page.locator('[data-stress-nested-outer]').innerText()).includes('outer')
		);
		const inner = page.locator('[data-stress-nested-inner]');
		check(
			'nested: INNER promise (inside the resolved value) streamed + resolved',
			(await inner.getAttribute('data-stress-nested-inner')) === 'resolved' &&
				INNER_DEEP_RE.test(await inner.innerText())
		);

		const many = page.locator('[data-stress-many]');
		check(
			'12 staggered promises all resolved',
			(await many.getAttribute('data-stress-many')) === 'resolved' &&
				(await many.getAttribute('data-stress-many-count')) === '12'
		);
		check(
			'last of the 12 carries its own value (no id/value mixups)',
			(await many.getAttribute('data-stress-many-last')) === 'm11'
		);

		check(
			'falsy resolution (null) round-trips',
			(await page.locator('[data-stress-falsy]').innerText()).trim() === 'null'
		);

		// Custom transport type: fahrenheit = 20*1.8+32 = 68 (plain), 100*1.8+32 = 212 (streamed). The
		// getter only computes if `decode` rebuilt the class — a plain object would give '(not a Temperature)'.
		check(
			'custom transport type in page.data rebuilt (getter works)',
			(await page.locator('[data-stress-temp]').getAttribute('data-stress-temp')) === '68'
		);
		check(
			'custom transport type INSIDE a streamed promise rebuilt',
			(await page.locator('[data-stress-temp-async]').getAttribute('data-stress-temp-async')) ===
				'212'
		);

		check(
			'no page / console errors (rejection handled, no unhandled rejection)',
			errors.length === 0,
			errors.join(' | ')
		);
	});
});
