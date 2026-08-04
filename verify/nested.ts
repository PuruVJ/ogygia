// Nested-island checks (fetch + Playwright). Usage: node verify/nested.ts [baseUrl]
// An island whose own source imports another component `with { island }`: the inner island
// degrades to a normal component and hydrates ONCE, with its parent.
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const count = (s: string, re: RegExp) => (s.match(re) || []).length;

let isDev = false;
{
	const res = await fetch(base + '/nested');
	const html = await res.text();
	isDev = /@vite\/client/.test(html) || /\/@fs\//.test(html) || /\/@id\//.test(html);
	check('/nested returns 200', res.status === 200);
	check('/nested emits exactly ONE sk-island (outer only; inner degraded)', count(html, /<sk-island/g) === 1, `${count(html, /<sk-island/g)}`);
	check('/nested outer island SSR content', /data-outer/.test(html));
	check('/nested inner rendered INLINE in SSR (no inner sk-island)', /inner child/.test(html));
	// a SERVER island nested inside a client island degrades to an inline normal component
	check('/nested nested SERVER island degraded to inline (no server sk-island)', count(html, /data-strategy="server"/g) === 0);
	check('/nested nested server greeting rendered inline (Hey, ...)', /Hey, \w+!/.test(html));
	check('/nested ships NO Kit bootstrap (csr=false)', !/__sveltekit/.test(html));
}

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const errs: string[] = [];
	const warns: string[] = [];
	page.on('pageerror', (e) => errs.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'warning') warns.push(m.text());
	});
	await page.goto(base + '/nested', { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('[data-outer]', { timeout: 5000 });

	// exactly one sk-island in the live DOM, hydrated once; inner never becomes its own island
	check('live DOM has exactly one sk-island', (await page.locator('sk-island').count()) === 1);
	await page.waitForSelector('sk-island[data-hydrated]', { timeout: 5000 }).catch(() => {});
	check('the outer island hydrated', (await page.locator('sk-island[data-hydrated]').count()) === 1);
	check('no stray nested sk-island element', (await page.locator('sk-island[data-nested]').count()) === 0);

	// outer interactive
	await page.click('[data-outer-btn]');
	await page.click('[data-outer-btn]');
	check('outer island is interactive', (await page.locator('[data-outer-m]').textContent()) === '2');

	// inner interactive (hydrated with the parent, single hydration)
	await page.locator('[data-inner]').scrollIntoViewIfNeeded();
	await page.click('[data-inner]');
	check('inner (degraded) island is interactive', (await page.locator('[data-inner-n]').textContent()) === '1');

	check('no page errors (single hydration, no mismatch)', errs.length === 0, errs.slice(0, 2).join('; '));

	// dev-only warning naming the nested island
	if (isDev) {
		const warned = warns.some((w) => /nested island/i.test(w) && /ogygia/.test(w));
		check('dev warning fired for the nested island', warned, warns.filter((w) => /ogygia/.test(w)).slice(0, 1).join(''));
	} else {
		check('no nested-island warning in production build', !warns.some((w) => /nested island/i.test(w)));
		out.push('SKIP  dev-warning presence check (prod build)');
	}

	await page.close();
} finally {
	await browser.close();
}

console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL NESTED-ISLAND CHECKS PASSED' : failures + ' NESTED-ISLAND CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
