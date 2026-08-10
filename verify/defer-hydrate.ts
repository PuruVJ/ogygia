// Deferred client islands (defer + hydrate). Usage: node verify/defer-hydrate.ts [baseUrl]
// Against /defer-wake:
//   - match (load+load): fallback → swap → hydrate → counter click
//   - idle-match (idle+idle): coalesce after idle fetch → interactive
//   - mismatch (load+visible): HTML below fold after load fetch; NOT hydrated until scroll;
//     then interactive. Props sibling + modulepreload present for coalesce cases.
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (s: string, re: RegExp) => (s.match(re) || []).length;

// ---------------------------------------------------------------- fetch/SSR --
{
	const res = await fetch(base + '/defer-hydrate');
	const html = await res.text();
	check('/defer-hydrate returns 200', res.status === 200);
	check(
		'/defer-hydrate has three deferred regions',
		count(html, /<ogygia-region\b[^>]*\brender="defer"/g) === 3,
		`${count(html, /<ogygia-region\b[^>]*\brender="defer"/g)}`
	);
	check(
		'/defer-hydrate regions carry hydrate (deferred client)',
		count(html, /<ogygia-region\b[^>]*\bwake="/g) === 3
	);
	check(
		'/defer-hydrate entry is a module URL (not opaque id alone)',
		/<ogygia-region\b[^>]*\bentry="[^"]*ogygia-island\.[^"]+"/.test(html) ||
			/<ogygia-region\b[^>]*\bentry="[^"]*\/@id\//.test(html) ||
			/<ogygia-region\b[^>]*\bentry="[^"]*virtual:ogygia/.test(html)
	);
	check(
		'/defer-hydrate emits props sibling scripts',
		count(html, /data-ogygia-props/g) === 3,
		`${count(html, /data-ogygia-props/g)}`
	);
	// Coalesce cases (wake:load OR hydrate===defer) → modulepreload; mismatch visible does not.
	const modulepreloads = count(html, /rel="modulepreload"/g);
	check(
		'/defer-hydrate modulepreload for coalesce cases (>=2)',
		modulepreloads >= 2,
		`count=${modulepreloads}`
	);
	check('/defer-hydrate fallbacks in initial HTML', /loading match/.test(html));
	check(
		'/defer-hydrate does NOT SSR counter buttons yet',
		!/count is 0/.test(html)
	);
	check('/defer-hydrate ships NO Kit bootstrap (csr=false)', !/__sveltekit/.test(html));
}

// --------------------------------------------------------------- browser -----
const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
	const errs: string[] = [];
	page.on('pageerror', (e) => errs.push(e.message));

	await page.goto(base + '/defer-hydrate', { waitUntil: 'domcontentloaded' });

	// --- match: load+load → fetch + immediate hydrate ---
	await page
		.waitForSelector('[data-dh="match"] ogygia-region[data-hydrated]', { timeout: 8000 })
		.catch(() => {});
	check(
		'match: region hydrated after defer swap',
		(await page.locator('[data-dh="match"] ogygia-region[data-hydrated]').count()) === 1
	);
	check(
		'match: fallback gone',
		(await page.locator('[data-fallback-match]').count()) === 0
	);
	check(
		'match: counter SSR HTML present',
		(await page.locator('[data-dh="match"] [data-counter]').count()) === 1
	);
	const matchBtn = page.locator('[data-dh="match"] [data-counter] button');
	await matchBtn.click();
	await matchBtn.click();
	check(
		'match: counter interactive after hydrate',
		(await matchBtn.textContent()) === 'count is 2',
		(await matchBtn.textContent()) || ''
	);

	// --- idle-match: idle+idle coalesce after idle fetch ---
	await page
		.waitForSelector('[data-dh="idle-match"] ogygia-region[data-hydrated]', { timeout: 8000 })
		.catch(() => {});
	check(
		'idle-match: hydrated (coalesce after idle fetch)',
		(await page.locator('[data-dh="idle-match"] ogygia-region[data-hydrated]').count()) === 1
	);
	const idleBtn = page.locator('[data-dh="idle-match"] [data-counter] button');
	await idleBtn.click();
	check(
		'idle-match: counter interactive',
		(await idleBtn.textContent()) === 'count is 1',
		(await idleBtn.textContent()) || ''
	);

	// --- mismatch: load fetch fills HTML below fold; hydrate waits for visible ---
	await page
		.waitForFunction(
			() =>
				!!document.querySelector('[data-dh="mismatch"] [data-counter]') &&
				!document.querySelector('[data-dh="mismatch"] ogygia-region[data-hydrated]'),
			{ timeout: 8000 }
		)
		.catch(() => {});
	const mismatchHtml = (await page.locator('[data-dh="mismatch"] [data-counter]').count()) === 1;
	const mismatchHydratedBefore =
		(await page.locator('[data-dh="mismatch"] ogygia-region[data-hydrated]').count()) === 1;
	check('mismatch: HTML swapped before scroll (fill:load)', mismatchHtml);
	check('mismatch: NOT hydrated before scroll (wake:visible)', !mismatchHydratedBefore);

	if (mismatchHtml && !mismatchHydratedBefore) {
		const deadBtn = page.locator('[data-dh="mismatch"] [data-counter] button');
		const before = await deadBtn.textContent();
		await deadBtn.click({ force: true }).catch(() => {});
		await sleep(100);
		const after = await deadBtn.textContent();
		check(
			'mismatch: click before hydrate does not update count',
			before === after && /count is 0/.test(before || ''),
			`before=${before} after=${after}`
		);
	}

	await page.locator('[data-dh="mismatch"]').scrollIntoViewIfNeeded();
	await page
		.waitForSelector('[data-dh="mismatch"] ogygia-region[data-hydrated]', { timeout: 8000 })
		.catch(() => {});
	check(
		'mismatch: hydrated after scroll',
		(await page.locator('[data-dh="mismatch"] ogygia-region[data-hydrated]').count()) === 1
	);
	const misBtn = page.locator('[data-dh="mismatch"] [data-counter] button');
	await misBtn.click();
	await misBtn.click();
	check(
		'mismatch: counter interactive after phase-2 hydrate',
		(await misBtn.textContent()) === 'count is 2',
		(await misBtn.textContent()) || ''
	);

	check('no page errors', errs.length === 0, errs.slice(0, 2).join('; '));

	await page.close();
} finally {
	await browser.close();
}

console.log(out.join('\n'));
console.log(
	`\n${failures === 0 ? 'ALL DEFER-HYDRATE CHECKS PASSED' : failures + ' DEFER-HYDRATE CHECK(S) FAILED'}`
);
process.exit(failures === 0 ? 0 : 1);
