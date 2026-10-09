// Batch frame stream (navigation OOO streaming) — server proof over HTTP. Usage: pnpm exec playwright test frame-batch
//
// Harvests the signed region calls from a page with several deferred regions, POSTs them to the
// batch endpoint, and asserts ONE response streams a frame per call (plus the done sentinel). This
// is the on-navigation case Ryan asked about: one response, fragments flushed as each settles.
// The client reader (runtime/frame-nav.ts) writes each frame into the store; the store + its
// subscription are covered by test/frame-store.test.ts and verify/frame-dedupe.ts.
import { test, check } from './fixtures/index.ts';
import {
	AMP_ENTITY_G_RE,
	AMP_NUMERIC_G_RE,
	LEADING_DOTS_RE,
	REGION_ENDPOINT_G_RE
} from './fixtures/re.ts';

const SLOT_RE = /<template data-ogygia-slot="([^"]+)">/g;
const NONEMPTY_FRAME_RE = /<template data-ogygia-slot="(?!__ogygia_done__)[^"]+">\s*\S/;

const unentity = (s: string) => s.replace(AMP_ENTITY_G_RE, '&').replace(AMP_NUMERIC_G_RE, '&');

test.describe('batch frame stream: one response, a frame per call (nav OOO)', () => {
	test('one POST streams a frame per call, the done sentinel once, and drops forged calls', async ({
		baseURL
	}) => {
		// A page with multiple distinct deferred regions (different props ⇒ different calls).
		const html = await (await fetch(baseURL + '/frame-batch')).text();
		const endpoints = [
			...new Set([...html.matchAll(REGION_ENDPOINT_G_RE)].map((m) => unentity(m[1])))
		];
		check('page exposes ≥2 distinct deferred calls', endpoints.length >= 2, `${endpoints.length}`);
		// The script bailed here (nothing to POST); the soft check above already recorded the failure.
		if (endpoints.length === 0) return;

		const q = endpoints[0].indexOf('?');
		// Endpoints are page-relative ("./__ogygia__?…"); make an absolute path for node fetch.
		const path =
			'/' + (q === -1 ? endpoints[0] : endpoints[0].slice(0, q)).replace(LEADING_DOTS_RE, '');

		const res = await fetch(baseURL + path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(endpoints)
		});
		check('batch endpoint answers 200', res.status === 200, `status ${res.status}`);
		check('batch is an html stream', (res.headers.get('content-type') || '').includes('text/html'));
		check('batch is uncacheable', (res.headers.get('cache-control') || '').includes('no-store'));

		const body = await res.text();
		const slots = [...body.matchAll(SLOT_RE)].map((m) => m[1]);
		const done = slots.filter((s) => s === '__ogygia_done__').length;
		const real = slots.filter((s) => s !== '__ogygia_done__');
		check(
			'one frame per call',
			real.length === endpoints.length,
			`${real.length} of ${endpoints.length}`
		);
		check('done sentinel present exactly once', done === 1, `${done}`);
		check('frames carry rendered content (not empty holes)', NONEMPTY_FRAME_RE.test(body));

		// A forged/garbage call in the batch is dropped, not fatal — the good ones still stream.
		const mixed = await fetch(baseURL + path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify([
				endpoints[0],
				'/__ogygia__?id=deadbeef0000&props=x&exp=9999999999&sig=forged'
			])
		});
		const mixed_body = mixed.status === 200 ? await mixed.text() : '';
		const mixed_real = [...mixed_body.matchAll(SLOT_RE)]
			.map((m) => m[1])
			.filter((s) => s !== '__ogygia_done__');
		check(
			'forged call dropped, valid one still streams',
			mixed.status === 200 && mixed_real.length === 1,
			`${mixed_real.length} frames`
		);
	});
});
