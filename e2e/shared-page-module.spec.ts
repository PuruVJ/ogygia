// ONE FILE, TWO WORLDS, through an ALIAS. `$boot/read-page` reads the page through `$app/state`
// and is imported by the csr=true /kit page (Kit's real page) AND by an island on a csr=false page
// (the seeded shim). The client build compiles that file once and resolves its `$app/state` once;
// membership in the island world decides which. The eager island-closure walk makes that decision
// deterministic — but it stopped at app aliases, so a helper reached only through `$lib_x/…` went
// to whichever world resolved it first. On a customer's dev server the account page (Kit) came
// first and the same helper then read `page.data.user` as empty inside an island on every public
// page. Now the walk follows aliases, and in dev an island registered later re-marks its closure.
//
// Build leg: the island reads the seed; the Kit page reads Kit's page (the kit-page thread).
// Dev leg: the Kit page loads FIRST (its copy resolves the shared module), then the csr=false
// page — the island must still read the seed.
//
//   pnpm exec playwright test shared-page-module
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, check } from './fixtures/index.ts';
import { spawn_server, type SpawnedServer } from './fixtures/servers.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const playground = join(repo, 'apps', 'playground');
const PORT = 3083;
const dev_base = `http://127.0.0.1:${PORT}`;

test.describe('a page-reading module shared by a csr=true page and an island', () => {
	test('build: the island reads the seeded page, the Kit page reads Kit’s page', async ({ page }) => {
		await page.goto('/shared-page-module', { waitUntil: 'networkidle' });
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 10_000 });
		check('island read page.data through the shared helper (Ada)', (await page.locator('[data-shared-name]').getAttribute('data-shared-name')) === 'Ada');

		await page.goto('/kit', { waitUntil: 'networkidle' });
		check('the Kit page’s copy read Kit’s real page data (Kit)', (await page.locator('[data-kit-shared-name]').getAttribute('data-kit-shared-name')) === 'Kit');
	});
});

test.describe('dev: the Kit page loads first, then the island page', () => {
	let srv: SpawnedServer | null = null;

	test.beforeAll(async () => {
		srv = await spawn_server({
			cmd: 'pnpm',
			args: ['--dir', playground, 'dev', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
			cwd: repo,
			url: `${dev_base}/kit`,
			timeout_ms: 120_000
		});
	});

	test.afterAll(() => {
		srv?.kill();
	});

	test('the island still reads the seed after the Kit page claimed the shared module', async ({ page }) => {
		test.setTimeout(120_000);
		await page.goto(`${dev_base}/kit`, { waitUntil: 'networkidle' });
		check('Kit page first: its copy reads Kit’s page (Kit)', (await page.locator('[data-kit-shared-name]').getAttribute('data-kit-shared-name')) === 'Kit');

		await page.goto(`${dev_base}/shared-page-module`, { waitUntil: 'networkidle' });
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 20_000 });
		check('then the island: the shared helper reads the seeded page (Ada), not Kit’s empty one', (await page.locator('[data-shared-name]').getAttribute('data-shared-name')) === 'Ada', await page.locator('[data-shared-name]').getAttribute('data-shared-name'));
	});
});
