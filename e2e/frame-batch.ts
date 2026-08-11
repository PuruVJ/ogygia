// Batch frame stream (navigation OOO streaming) — server proof over HTTP. Usage: node verify/frame-batch.ts [baseUrl]
//
// Harvests the signed region calls from a page with several deferred regions, POSTs them to the
// batch endpoint, and asserts ONE response streams a frame per call (plus the done sentinel). This
// is the on-navigation case Ryan asked about: one response, fragments flushed as each settles.
// The client reader (runtime/frame-nav.ts) writes each frame into the store; the store + its
// subscription are covered by test/frame-store.test.ts and verify/frame-dedupe.ts.
const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out: string[] = [];
const check = (name: string, cond: boolean, extra = '') => {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};
const unentity = (s: string) => s.replace(/&amp;/g, '&').replace(/&#38;/g, '&');

// A page with multiple distinct deferred regions (different props ⇒ different calls).
const html = await (await fetch(base + '/frame-batch')).text();
const endpoints = [
	...new Set(
		[...html.matchAll(/<ogygia-region\b[^>]*\bendpoint="([^"]+)"/g)].map((m) => unentity(m[1]))
	)
];
check('page exposes ≥2 distinct deferred calls', endpoints.length >= 2, `${endpoints.length}`);
if (endpoints.length === 0) {
	console.log(out.join('\n'));
	process.exit(1);
}

const q = endpoints[0].indexOf('?');
// Endpoints are page-relative ("./🏝️?…"); make an absolute path for node fetch.
const path = '/' + (q === -1 ? endpoints[0] : endpoints[0].slice(0, q)).replace(/^[./]+/, '');

const res = await fetch(base + path, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(endpoints)
});
check('batch endpoint answers 200', res.status === 200, `status ${res.status}`);
check('batch is an html stream', (res.headers.get('content-type') || '').includes('text/html'));
check('batch is uncacheable', (res.headers.get('cache-control') || '').includes('no-store'));

const body = await res.text();
const slots = [...body.matchAll(/<template data-ogygia-slot="([^"]+)">/g)].map((m) => m[1]);
const done = slots.filter((s) => s === '__ogygia_done__').length;
const real = slots.filter((s) => s !== '__ogygia_done__');
check('one frame per call', real.length === endpoints.length, `${real.length} of ${endpoints.length}`);
check('done sentinel present exactly once', done === 1, `${done}`);
check(
	'frames carry rendered content (not empty holes)',
	/<template data-ogygia-slot="(?!__ogygia_done__)[^"]+">\s*\S/.test(body)
);

// A forged/garbage call in the batch is dropped, not fatal — the good ones still stream.
const mixed = await fetch(base + path, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify([endpoints[0], '/🏝️?id=deadbeef0000&props=x&exp=9999999999&sig=forged'])
});
const mixedBody = mixed.status === 200 ? await mixed.text() : '';
const mixedReal = [...mixedBody.matchAll(/<template data-ogygia-slot="([^"]+)">/g)].map((m) => m[1]).filter((s) => s !== '__ogygia_done__');
check('forged call dropped, valid one still streams', mixed.status === 200 && mixedReal.length === 1, `${mixedReal.length} frames`);

console.log(out.join('\n'));
process.exit(failures);

export {};
