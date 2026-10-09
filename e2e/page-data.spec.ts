// $page.data works INSIDE islands on csr=false — including STREAMED load promises, mirroring Kit's
// own promise streaming (which is dead on csr=false: no page hydration). The handle can't reach the
// resolved load data (Kit merges it locally in render.js, never on RequestState), so Region.svelte
// reads Kit's REAL page during SSR and records it; the handle seeds data/form/error/status. A load
// PROMISE is STAGED to a marker (a pending Promise on the client) and a resolve `<script>` streams per
// promise as it settles — so the shell + pending UI paint immediately (FCP at t=0) and each island's
// `{#await}` resolves live. Kit's own dead resolve tail is drained server-side, so there is NO
// `__sveltekit_<hash> is not defined` console error.
//
// This asserts BOTH levels:
//   • stream level  — the document (pending shell + defer markers + bootstrap) arrives BEFORE either
//                     promise settles; resolve scripts stream after, fast-first (completion order).
//   • visual level  — after load, the island reads plain data + both resolved promise values, zero errors.
// Usage: pnpm exec playwright test page-data
import http from 'node:http';
import https from 'node:https';
import { test, check } from './fixtures/index.ts';

const FAST_RESOLVE_RE = /__ogygia_page_resolve\([^)]*FAST/;
const SLOW_RESOLVE_RE = /__ogygia_page_resolve\([^)]*STREAMED/;
const PD_SLOW_PENDING_RE = /data-pd-slow="pending"/;
const OGYGIA_DEFER_RE = /OgygiaDefer/;
const KIT_RESOLVE_TAIL_RE = /__sveltekit_\w+\.resolve/;
const FAST_VALUE_RE = /FAST-VALUE/;
const STREAMED_VALUE_RE = /STREAMED-VALUE/;

/** Raw streamed request with per-chunk timings. Uses node:http (NOT fetch — fetch strips the
 *  forbidden `Sec-Fetch-Mode` header, so it would never reach the streaming path). */
function stream_probe(url: string, headers: Record<string, string>) {
	const lib = url.startsWith('https') ? https : http;
	return new Promise<{
		doc: string;
		full: string;
		doc_ms: number;
		fast_ms: number;
		slow_ms: number;
	}>((resolve, reject) => {
		const t0 = Date.now();
		const req = lib.get(url, { headers }, (res) => {
			let doc = '';
			let full = '';
			let doc_ms = -1;
			let fast_ms = -1;
			let slow_ms = -1;
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => {
				full += chunk;
				if (doc_ms < 0) {
					doc += chunk;
					if (doc.includes('</body>')) doc_ms = Date.now() - t0;
				}
				if (fast_ms < 0 && FAST_RESOLVE_RE.test(full)) fast_ms = Date.now() - t0;
				if (slow_ms < 0 && SLOW_RESOLVE_RE.test(full)) slow_ms = Date.now() - t0;
			});
			res.on('end', () => resolve({ doc, full, doc_ms, fast_ms, slow_ms }));
			res.on('error', reject);
		});
		req.on('error', reject);
	});
}

test.describe('$page.data reaches islands + load promises STREAM in (marker seed, resolve-per-settle, Kit tail drained)', () => {
	// ── stream level: read the raw response chunk-by-chunk with timings ──────────────────────────────
	test('stream level: the document ships before either promise settles; resolves stream fast-first', async ({
		baseURL
	}) => {
		const { doc, full, doc_ms, fast_ms, slow_ms } = await stream_probe(baseURL + '/page-data', {
			'sec-fetch-mode': 'navigate',
			accept: 'text/html'
		});
		check(
			'SSR shell renders the island PENDING (not blocked on the promise)',
			PD_SLOW_PENDING_RE.test(doc)
		);
		check(
			'seed carries a DEFER MARKER, not the resolved value (true streaming, not settle-at-seed)',
			OGYGIA_DEFER_RE.test(doc) && !doc.includes('STREAMED-VALUE')
		);
		check(
			'resolve-global bootstrap ships in the document',
			doc.includes('__ogygia_page_resolve=function')
		);
		check(
			'document shipped BEFORE either promise settled (< 300ms; promises at 90/350ms)',
			doc_ms >= 0 && doc_ms < 300,
			`doc@${doc_ms}ms`
		);
		check(
			'a resolve script streamed for each promise',
			fast_ms >= 0 && slow_ms >= 0,
			`fast@${fast_ms}ms slow@${slow_ms}ms`
		);
		check(
			'resolves stream fast-first (completion order, independent)',
			fast_ms >= 0 && slow_ms >= 0 && fast_ms < slow_ms,
			`fast@${fast_ms}ms slow@${slow_ms}ms`
		);
		check(
			"Kit's dead csr=false resolve tail is drained (no __sveltekit resolver leaks to the client)",
			!KIT_RESOLVE_TAIL_RE.test(full)
		);
	});

	// ── visual level: hydrate in a real browser ──────────────────────────────────────────────────────
	test('visual level: the island reads plain data + both resolved promise values, zero errors', async ({
		page
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push('console: ' + m.text());
		});
		await page.goto('/page-data', { waitUntil: 'networkidle' });
		await page.waitForTimeout(200);

		const r = page.locator('[data-pd-reader]');
		check('island reads $page.data.locale', (await r.getAttribute('data-pd-locale')) === 'fr-FR');
		check(
			'island reads $page.data.countryApiKey',
			(await r.getAttribute('data-pd-apikey')) === 'abc-123'
		);
		check(
			'island reads nested $page.data.nested.flags.helpCenter',
			(await r.getAttribute('data-pd-help')) === 'true'
		);
		check('island reads $page.status', (await r.getAttribute('data-pd-status')) === '200');

		const fast = page.locator('[data-pd-fast]');
		check(
			'fast promise resolved into the island',
			(await fast.getAttribute('data-pd-fast')) === 'resolved' &&
				FAST_VALUE_RE.test(await fast.innerText())
		);
		const slow = page.locator('[data-pd-slow]');
		check(
			'slow promise resolved into the island',
			(await slow.getAttribute('data-pd-slow')) === 'resolved' &&
				STREAMED_VALUE_RE.test(await slow.innerText())
		);

		check(
			'no page / console errors (Kit stream noise gone)',
			errors.length === 0,
			errors.join(' | ')
		);
	});
});
