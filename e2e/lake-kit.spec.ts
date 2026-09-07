// LAKE UNDER KIT HYDRATION: a `wake: 'none'` chrome lake in a csr=false layout that ALSO serves a
// csr=true page (Kit hydrates the whole document there). The lake's component is a render-nothing
// placeholder on the client, so the wrapper must ADOPT the SSR element verbatim under Kit's hydration
// — before this, the mismatch made Kit re-render the page client-side and the lake VANISHED (a site
// header on a csr=true page). Inside the lake ogygia's world holds on both pages: the header island
// emits its real region and wakes on the runtime, the greeting hole fetches, and the lake's code
// ships in no client chunk.
//
//   pnpm exec playwright test lake-kit
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, check, sleep } from './fixtures/index.ts';
import { REGION_TAG_G_RE, RUNTIME_SCRIPT_RE } from './fixtures/re.ts';

const JS_FILE_RE = /\.(js|mjs)$/;
// The distinctive string in the lake component (LakeChrome): server build yes, client chunks never.
const MARKER = 'LAKE_CHROME_CODE_MARKER_5c1e';
const LAKE_RE = /<ogygia-region entry="[^"]+" wake="none" remount="cache">/;
const LAKE_STATIC_RE = /data-lake-static/;
// The header island inside the lake as a REAL region (its shell precedes its markup), not inline.
const HEADER_REGION_RE = /<ogygia-region entry="[^"]+" wake="load"[^>]*>[^<]*(?:<!--[^>]*-->)*<header data-chrome-header/;
const HOLE_RE = /<ogygia-region entry="[^"]*" render="defer"/;
const HYDRATION_MISMATCH_RE = /hydration_mismatch/;

const repo = fileURLToPath(new URL('..', import.meta.url));
const client_dir = join(repo, 'apps/playground', '.svelte-kit', 'output', 'client');
const server_dir = join(repo, 'apps/playground', '.svelte-kit', 'output', 'server');

function grep_dir(dir: string): number {
	let hits = 0;
	const walk = (d: string) => {
		let entries: import('node:fs').Dirent[];
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(d, e.name);
			if (e.isDirectory()) walk(full);
			else if (JS_FILE_RE.test(e.name) && readFileSync(full, 'utf-8').includes(MARKER)) hits++;
		}
	};
	walk(dir);
	return hits;
}

test.describe('lake under Kit hydration — csr=true page under a lake-chrome layout', () => {
	test('SSR: the csr=true page carries the lake as ONE frozen region, real regions inside, runtime shipped', async ({
		baseURL
	}) => {
		const html = await (await fetch(baseURL + '/lake-kit/kit/')).text();
		check('lake emitted as a frozen region element', LAKE_RE.test(html));
		check('lake HTML rendered inside it', LAKE_STATIC_RE.test(html));
		check(
			'exactly one frozen region (one element to adopt)',
			(html.match(/wake="none"/g) ?? []).length === 1
		);
		check('header island inside the lake is a REAL region (not inlined)', HEADER_REGION_RE.test(html));
		check('greeting hole inside the lake is a real deferred region', HOLE_RE.test(html));
		check(
			'lake + header + hole: ≥ 3 regions',
			(html.match(REGION_TAG_G_RE) ?? []).length >= 3,
			`count=${(html.match(REGION_TAG_G_RE) ?? []).length}`
		);
		check('runtime shipped (the lake’s regions are ours to wake)', RUNTIME_SCRIPT_RE.test(html));
	});

	test('browser: Kit hydrates the page; the lake survives, its island wakes, its hole fills', async ({
		page
	}) => {
		const errs: string[] = [];
		const warns: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'error') errs.push('console: ' + m.text());
			if (m.type() === 'warning') warns.push(m.text());
		});
		await page.goto('/lake-kit/kit/', { waitUntil: 'networkidle' });
		await sleep(500);

		check('lake SURVIVED Kit hydration (did not vanish)', (await page.locator('[data-lake-static]').count()) === 1);
		check('still exactly one frozen region', (await page.locator('ogygia-region[wake="none"]').count()) === 1);
		check(
			'no hydration mismatch',
			!warns.some((w) => HYDRATION_MISMATCH_RE.test(w)),
			warns.filter((w) => HYDRATION_MISMATCH_RE.test(w)).slice(0, 1).join('; ')
		);
		check(
			'header island inside the lake hydrated on the RUNTIME',
			(await page.locator('ogygia-region[wake="none"] ogygia-region[wake="load"][data-hydrated]').count()) === 1
		);
		check(
			'nothing inside the lake was left to Kit',
			(await page.locator('ogygia-region[wake="none"] [data-kit-hydrated]').count()) === 0
		);
		const hbtn = page.locator('[data-chrome-header] button');
		await hbtn.click();
		check('header island interactive', (await hbtn.textContent())!.includes('h:1'));
		check('greeting hole fetched and swapped in', (await page.locator('[data-server-greeting]').count()) === 1);
		check('hole fallback gone', (await page.locator('[data-lake-fallback]').count()) === 0);
		const kbtn = page.locator('[data-kit-btn]');
		await kbtn.click();
		check('Kit’s own client is alive next to the lake', (await kbtn.textContent())!.includes('kit:1'));
		check('no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
	});

	test('the csr=false sibling under the SAME layout: lake bare, island + hole alive', async ({
		page,
		baseURL
	}) => {
		const html = await (await fetch(baseURL + '/lake-kit/')).text();
		check('csr=false: shell lake renders bare (no frozen region element)', !/wake="none"/.test(html));
		check('csr=false: lake HTML present', LAKE_STATIC_RE.test(html));
		const errs: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));
		await page.goto('/lake-kit/', { waitUntil: 'networkidle' });
		await sleep(500);
		const hbtn = page.locator('[data-chrome-header] button');
		await hbtn.click();
		check('csr=false: header island interactive', (await hbtn.textContent())!.includes('h:1'));
		check('csr=false: greeting hole filled', (await page.locator('[data-server-greeting]').count()) === 1);
		check('csr=false: no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
	});

	test("build output: the lake's code ships in NO client chunk, IS in the server build", () => {
		test.skip(!existsSync(client_dir), 'no prod build output — run against a preview/prod build');
		const client_hits = grep_dir(client_dir);
		const server_hits = grep_dir(server_dir);
		check('lake code in NO client chunk (Kit’s bundle included)', client_hits === 0, `${client_hits} chunk(s)`);
		check('lake code IS in the server build', server_hits >= 1, `${server_hits} file(s)`);
	});
});
