// ERROR PAGES UNDER csr=false PAGES ARE KIT-HYDRATED. Kit renders a route's `+error.svelte` from
// the LAYOUT branch alone (`PageNodes(layouts)` in its server renderer): the page node — and with
// it the page's `csr = false` — is dropped, so a 404 / 500 under a client-off page is hydrated
// whenever the layouts say so (a real app's root layout usually leaves csr at Kit's default, true).
// ogygia keyed the document on the PAGE's csr there: the chrome lake rendered bare into a document
// Kit then hydrated, the markup mismatched, Svelte discarded the SSR DOM and re-rendered — and the
// site header VANISHED on every 404/500 of a customer deploy. The fix keys an error render on the
// error twin of the route map (`error_csr_true_routes`), so the lake comes out adoptable and the
// handle stamps `<meta name="ogygia-csr">`, exactly like a csr=true page.
//
//   pnpm exec playwright test error-kit
import { test, check, sleep } from './fixtures/index.ts';
import { KIT_BOOT_RE, RUNTIME_SCRIPT_RE } from './fixtures/re.ts';

const CSR_META_RE = /<meta name="ogygia-csr" content="true">/;
const LAKE_RE = /<ogygia-region entry="[^"]+" wake="none" remount="cache">/;
const LAKE_STATIC_RE = /data-lake-static/;
// The header island inside the lake as a REAL region (its shell precedes its markup), not inline.
const HEADER_REGION_RE = /<ogygia-region entry="[^"]+" wake="load"[^>]*>[^<]*(?:<!--[^>]*-->)*<header data-chrome-header/;
const HYDRATION_MISMATCH_RE = /hydration_mismatch/;
// The browser logs the DOCUMENT's own 404 / 500 status as a console error — the response under
// test, not a page error.
const DOCUMENT_STATUS_LOG_RE = /Failed to load resource: the server responded with a status of (?:404|500)/;

for (const [path, status] of [
	['/error-kit/missing/', 404],
	['/error-kit/boom/', 500]
] as const) {
	test.describe(`${status} under a csr=false page (layout csr=true)`, () => {
		test(`SSR: the ${status} is rendered as a Kit-hydrated document — lake adoptable, csr meta stamped`, async ({
			baseURL
		}) => {
			const res = await fetch(baseURL + path);
			check(`status ${status}`, res.status === status, String(res.status));
			const html = await res.text();
			check('Kit ships its bootstrap (the layouts hydrate)', KIT_BOOT_RE.test(html));
			check('handle stamped the csr meta (the runtime reads it, never Kit’s bootstrap)', CSR_META_RE.test(html));
			check('lake emitted as ONE frozen region element (the adoptable form)', LAKE_RE.test(html));
			check('exactly one frozen region', (html.match(/wake="none"/g) ?? []).length === 1);
			check('lake HTML rendered inside it', LAKE_STATIC_RE.test(html));
			check('header island inside the lake is a REAL region', HEADER_REGION_RE.test(html));
			check('runtime shipped (the lake’s regions are ours to wake)', RUNTIME_SCRIPT_RE.test(html));
			check('the error page itself rendered', html.includes('data-error-page'));
		});

		test(`browser: Kit hydrates the ${status}; the lake SURVIVES, its island wakes, Kit’s client is alive`, async ({
			page
		}) => {
			const errs: string[] = [];
			const warns: string[] = [];
			page.on('pageerror', (e) => errs.push(e.message));
			page.on('console', (m) => {
				if (m.type() === 'error' && !DOCUMENT_STATUS_LOG_RE.test(m.text())) errs.push('console: ' + m.text());
				if (m.type() === 'warning') warns.push(m.text());
			});
			await page.goto(path, { waitUntil: 'networkidle' });
			await sleep(500);

			check('lake SURVIVED Kit hydration (the header did not vanish)', (await page.locator('[data-lake-static]').count()) === 1);
			check('still exactly one frozen region', (await page.locator('ogygia-region[wake="none"]').count()) === 1);
			check(
				'no hydration mismatch',
				!warns.some((w) => HYDRATION_MISMATCH_RE.test(w)),
				warns.filter((w) => HYDRATION_MISMATCH_RE.test(w)).slice(0, 1).join('; ')
			);
			check(
				'header island inside the lake hydrated on the RUNTIME',
				(await page.locator('ogygia-region[wake="none"] ogygia-region[wake="load"][data-hydrated]:has([data-chrome-header])').count()) === 1
			);
			const hbtn = page.locator('[data-chrome-header] button');
			await hbtn.click();
			check('header island interactive', (await hbtn.textContent())!.includes('h:1'));
			check('greeting hole fetched and swapped in', (await page.locator('[data-server-greeting]').count()) === 1);
			check(`error page shows ${status}`, (await page.locator('[data-error-page]').textContent())!.includes(String(status)));
			const kbtn = page.locator('[data-kit-btn]');
			await kbtn.click();
			check('Kit’s own client is alive on the error page', (await kbtn.textContent())!.includes('kit:1'));
			check('no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
		});
	});
}

test('control: the csr=false page under the SAME layout stays client-off — lake bare, no csr meta', async ({
	page,
	baseURL
}) => {
	const html = await (await fetch(baseURL + '/error-kit/')).text();
	check('no Kit bootstrap', !KIT_BOOT_RE.test(html));
	check('no csr meta', !CSR_META_RE.test(html));
	check('lake renders bare (no frozen region element)', !/wake="none"/.test(html));
	check('lake HTML present', LAKE_STATIC_RE.test(html));
	const errs: string[] = [];
	page.on('pageerror', (e) => errs.push(e.message));
	await page.goto('/error-kit/', { waitUntil: 'networkidle' });
	await sleep(500);
	const hbtn = page.locator('[data-chrome-header] button');
	await hbtn.click();
	check('header island interactive', (await hbtn.textContent())!.includes('h:1'));
	check('no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
});
