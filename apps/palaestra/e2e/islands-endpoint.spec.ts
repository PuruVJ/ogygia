// A MOVED ISLANDS ENDPOINT: `handle({ endpoint })` moves the handler AND every URL minted for it.
// The built palaestra is served with OGYGIA_ENDPOINT set (apps/palaestra/src/hooks.server.ts), and a
// handle in front answers the default `/__ogygia__` with a 404 — a reverse proxy that forwards only
// the app's own prefixes. REGRESSION (field report, 0.8.0): the option moved only the handler; pages
// still minted `/__ogygia__?…` and every hole was empty.
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawn_server, type SpawnedServer } from '@ogygia/tooling/e2e/servers.ts';

const PORT = 4187;
const base = `http://127.0.0.1:${PORT}`;
const ENDPOINT = '/_server/api/__ogygia__';
const palaestra = fileURLToPath(new URL('..', import.meta.url));
let srv: SpawnedServer | null = null;

test.use({ baseURL: base });
test.beforeAll(async () => {
	// (the suite's webServer already built the palaestra: serve that build with the moved endpoint)
	srv = await spawn_server({
		cmd: process.execPath,
		args: [
			'node_modules/vite/bin/vite.js',
			'preview',
			'--port',
			String(PORT),
			'--strictPort',
			'--host',
			'127.0.0.1'
		],
		cwd: palaestra,
		env: { OGYGIA_ENDPOINT: ENDPOINT, ORIGIN: base },
		url: `${base}/lake-kit/`,
		timeout_ms: 60_000
	});
});
test.afterAll(() => srv?.kill());

for (const path of ['/lake-kit/', '/lake-kit/kit/']) {
	test(`${path}: every hole is minted on the moved endpoint and answers there`, async ({
		page
	}) => {
		const asked: string[] = [];
		page.on('request', (r) => {
			const p = new URL(r.url()).pathname;
			if (p.endsWith('/__ogygia__')) asked.push(p);
		});
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto(path);
		// the deferred hole inside the lake answered (its fallback gone)
		await expect(page.locator('[data-server-greeting]')).toHaveCount(1);
		await expect(page.locator('[data-lake-fallback]')).toHaveCount(0);
		const endpoints = await page.evaluate(() =>
			[...document.querySelectorAll('ogygia-region[endpoint]')].map(
				(r) => new URL(r.getAttribute('endpoint')!, location.href).pathname
			)
		);
		expect(endpoints.length).toBeGreaterThan(0);
		expect(endpoints.filter((p) => p !== '/_server/api/__ogygia__')).toEqual([]);
		// no request ever went to the default path
		expect(asked.length).toBeGreaterThan(0);
		expect(asked.filter((p) => p !== '/_server/api/__ogygia__')).toEqual([]);
		// the island inside the lake still hydrates
		await expect(page.locator('ogygia-region[data-hydrated] [data-chrome-header]')).toHaveCount(1);
		expect(errors).toEqual([]);
	});
}

test('the default path is no longer the handler: an unsigned request there is not ogygia’s', async ({
	request
}) => {
	const res = await request.get(`${base}/__ogygia__?id=x&sig=y`);
	expect(res.status()).toBe(404);
	// the moved path is: an unsigned probe gets ogygia’s own refusal
	expect((await request.get(`${base}${ENDPOINT}?id=x&sig=y`)).status()).toBe(403);
});
