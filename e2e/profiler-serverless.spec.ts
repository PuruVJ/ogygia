// The profiler on a serverless host: the instance that recorded a report is gone by the time you
// click anything (Amplify, any Lambda). Each "instance" here is a fresh `vite preview` of the same
// build with an EMPTY report database, so a report exists only in the browser that recorded it
// (IndexedDB). Every report action must still work: the page, the .html / .json downloads, the
// .ogp export, the share link, and "profile again & compare".
import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn_server, type SpawnedServer } from './fixtures/servers.js';

const PORT = 3071;
const ORIGIN = `http://localhost:${PORT}`;
const KEY = 'e2e-serverless';
const app = fileURLToPath(new URL('../apps/playground', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'og-prof-'));
let n = 0;
let server: SpawnedServer | undefined;

/** a new instance: the same build, a database no report was ever written to */
async function fresh_instance(env: Record<string, string> = {}) {
	server?.kill();
	await new Promise((r) => setTimeout(r, 400));
	server = await spawn_server({
		cmd: 'node',
		args: ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'],
		cwd: app,
		env: { ORIGIN, OGYGIA_PROFILER_SECRET: KEY, OGYGIA_PROFILES_DB: join(dir, `instance-${++n}.db`), ...env },
		url: `${ORIGIN}/robots.txt`
	});
}

async function record(page: Page, query: string): Promise<string> {
	await page.goto(`${ORIGIN}/__profiler/run?${query}`);
	await page.waitForURL(/\/__profiler\/(report|compare)\//, { timeout: 120_000 });
	return page.url();
}

test.describe('profiler on a serverless host', () => {
	test.use({ extraHTTPHeaders: { 'x-profiler-key': KEY }, acceptDownloads: true });
	test.afterAll(() => {
		server?.kill();
		rmSync(dir, { recursive: true, force: true });
	});

	test('every report action works after the recording instance is gone', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await fresh_instance();
		const report = await record(page, 'p=/inferno&runs=2');
		const id = report.split('/').pop()!;
		await expect(page.locator('.keep')).toHaveText('kept in this browser', { timeout: 15_000 });

		await fresh_instance();
		expect((await page.request.get(`${ORIGIN}/__profiler/report/${id}.json`)).status()).toBe(404);
		await page.goto(report);
		await expect(page.getByRole('heading', { name: /Slow patterns/ }).first()).toBeVisible({ timeout: 15_000 });

		const html = await Promise.all([page.waitForEvent('download'), page.locator('a.btn', { hasText: 'Download' }).click()]).then(([d]) => d.path());
		expect(readFileSync(html!, 'utf8')).toContain('ogygia-standalone');

		const json = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'JSON', exact: true }).click()]).then(([d]) => d.path());
		expect(JSON.parse(readFileSync(json!, 'utf8')).id).toBe(id);

		const ogp = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export/ }).click()]).then(([d]) => d.path());
		const back = await page.request.post(`${ORIGIN}/__profiler/view`, { headers: { 'content-type': 'application/octet-stream', accept: 'application/json', origin: ORIGIN }, data: readFileSync(ogp!) });
		expect(back.status()).toBe(200);

		await page.getByRole('button', { name: /share/i }).first().click();
		await page.locator('input[type=password]').fill('pw-e2e');
		await page.locator('form button').last().click();
		await expect(page.locator('input[readonly]').first()).toHaveValue(new RegExp(`/report/${id}#.{100,}`), { timeout: 15_000 });

		expect(errors).toEqual([]);
	});

	test('pick your fixes: the checklist recounts the forecast in the browser', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await fresh_instance();
		await record(page, 'p=/inferno&runs=2');
		const box = page.locator('details.whatif-box');
		await box.locator('summary').click();
		const sum = box.locator('.sum');
		const ms = async () => Number((await sum.innerText()).match(/about ([\d,.]+) ms/)![1].replace(/,/g, ''));
		const from = Number((await sum.innerText()).match(/from ([\d,.]+) ms/)![1].replace(/,/g, ''));
		// every fix ticked: the forecast's own number, below the render
		await expect(sum).toContainText(/fix(es)? ticked/, { timeout: 15_000 });
		const all = await ms();
		expect(all).toBeLessThan(from);
		// the biggest fix left out: the render after the rest is higher (waits for the island to wake)
		await expect(async () => {
			await box.locator('input[type=checkbox]').first().uncheck();
			expect(await ms()).toBeGreaterThan(all);
		}).toPass({ timeout: 15_000 });
		// none: the render as it is
		await box.getByRole('button', { name: 'Clear' }).click();
		await expect(sum).toContainText(`With the 0 fixes ticked`);
		expect(await ms()).toBe(from);
		expect(errors).toEqual([]);
	});

	test('on AWS Lambda a recording of the heaviest page answers inside the 30 s cut, with its passes in', async ({ request }) => {
		// Amplify's SSR: a 30 s request limit, 1 GB functions. Ask for far more renders than fit: the
		// recording trims itself to the budget and still keeps the retention and call-count passes.
		await fresh_instance({ AWS_LAMBDA_FUNCTION_NAME: 'e2e', AWS_LAMBDA_FUNCTION_MEMORY_SIZE: '1024' });
		const t = Date.now();
		const res = await request.get(`${ORIGIN}/__profiler/page?p=/hell&runs=50&format=keep`, { timeout: 60_000 });
		const ms = Date.now() - t;
		expect(res.status()).toBe(200);
		expect(ms, `took ${ms} ms`).toBeLessThan(28_500);
		const { dump } = await res.json();
		const extras = dump.extras ?? dump;
		expect(dump.meta.budget_note).toContain('serverless budget');
		expect(Object.keys(extras.call_counts ?? {}).length).toBeGreaterThan(0);
		expect(dump.meta.lambda).toBe(true);
		// the memory it bills with every ms (the capacity line's GB-seconds)
		expect(dump.meta.lambda_mb).toBe(1024);
	});

	test("the browser's CPU names an island by its component, not the minified name in its chunk", async ({ page }) => {
		await fresh_instance();
		const rec = await page.request.get(`${ORIGIN}/__profiler/page?p=/hell&runs=2`, { maxRedirects: 0, timeout: 120_000 });
		const id = rec.headers()['location']?.split('/').pop();
		expect(id).toBeTruthy();
		// the profiler's own visit (the key header): the page carries the beacon and samples its main
		// thread (JS Self-Profiling) from boot while islands keep waking — 8 s, up to 20 s on a slow,
		// loaded machine — then posts the trace
		test.setTimeout(240_000);
		let visit_at = Date.now();
		const res = await page.goto(`${ORIGIN}/hell`, { waitUntil: 'load' });
		expect(res?.headers()['document-policy']).toBe('js-profiling');
		// the islands' own files: each region's `src` (its content-hashed location — island code no
		// longer sits in a file named after the island)
		const island_files: string[] = await page.evaluate(() =>
			[...document.querySelectorAll('ogygia-region[src]')].map((r) => new URL(r.getAttribute('src')!, location.href).pathname.replace(/^\//, ''))
		);
		expect(island_files.length).toBeGreaterThan(0);
		await page.mouse.wheel(0, 3000);
		await expect(async () => {
			const j = await (await page.request.get(`${ORIGIN}/__profiler/report/${id}.json`)).json();
			const comps: { name: string; file: string }[] = j.browser?.cpu?.components ?? [];
			const islands = comps.filter((c) => island_files.some((f) => c.file.endsWith(f)));
			// the islands here hydrate in a few ms each and the browser samples every ~10 ms: one visit's
			// trace can miss them by chance. A trace that came in for this visit and missed: visit again
			// (each visit's trace replaces the last)
			if (!islands.length && (j.browser?.cpu?.at ?? 0) > visit_at) {
				visit_at = Date.now();
				await page.reload({ waitUntil: 'load' });
				await page.mouse.wheel(0, 3000);
			}
			// on a miss, say what the report did hold: no visit, a visit without a trace, or a trace off the islands
			const seen = j.browser ? `cpu: ${JSON.stringify(j.browser.cpu ? { sampled_ms: j.browser.cpu.sampled_ms, busy_ms: j.browser.cpu.busy_ms, files: comps.map((c) => c.file).slice(0, 8) } : null)}` : 'no browser visit';
			expect(islands.length, seen).toBeGreaterThan(0);
			// MegaHeader's chunk: named from the .svelte file in it, not `M`
			expect(islands.map((c) => c.name)).toContain('MegaHeader');
			for (const c of islands) expect(c.name.length, c.name).toBeGreaterThan(2);
		}).toPass({ timeout: 150_000, intervals: [2_000] });
	});

	test('profile again & compare renders from this browser when no instance holds either report', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await fresh_instance();
		const a = (await record(page, 'p=/inferno&runs=2')).split('/').pop()!;
		const compare = await record(page, `p=/inferno&runs=2&against=${a}`);
		expect(compare).toMatch(/\/compare\/\w+\/\w+$/);

		await fresh_instance();
		await page.goto(compare);
		await expect(page.getByRole('heading', { name: 'Summary' })).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText('render (median run)')).toBeVisible();
		expect(errors).toEqual([]);
	});
});
