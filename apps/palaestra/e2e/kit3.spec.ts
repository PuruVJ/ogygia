// SVELTEKIT 3 — a real Kit 3 app (internal/repro-kit3) on the PACKED ogygia, built and in dev.
// Kit 3 broke ogygia four ways at once, each only visible in a Kit 3 app:
// - its remote `form()` imports `refreshAll` from the client module ogygia stands in for: every
//   production build failed (`MISSING_EXPORT`);
// - its generated client entry moved under `generated/{build,dev}/`, so the kit-page thread was never
//   appended and islands on csr=true pages never got Kit's page;
// - the thread imported `$app/stores`, which Kit 3 removed (subscribing throws);
// - its remote ARGUMENT encoding reads the app's transport from a module only Kit's boot fills.
// The app: a lake in a csr=false layout (islands + a hole inside) serving a csr=false page and a
// csr=true page; an island with a remote form and the query it refreshes; an island whose query
// argument is a custom transport type; an island reading `page`.
//
// Standalone install (not a workspace member): a workspace link would resolve ogygia's own Kit 2 dev
// install next to the app's Kit 3. Usage: pnpm exec playwright test kit3
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect, check, sleep, stamp_document, document_stamp } from '@ogygia/tooling/e2e';
import { pack_ogygia, use_packed } from '@ogygia/tooling/e2e/packed.ts';
import { spawn_server, type SpawnedServer } from '@ogygia/tooling/e2e/servers.ts';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURE = join(REPO, 'internal', 'repro-kit3');
// outside the repo: nothing above the app may resolve a package for it (the repo root holds Kit 2)
const WORK = join(tmpdir(), 'ogygia-e2e-kit3');
const APP = join(WORK, 'app');
const BUILD_PORT = 3091;
const DEV_PORT = 3092;
const COPY_SKIP_RE = /node_modules|\.svelte-kit|(^|\/)build($|\/)/;
// a stable signing key, so the build and the server agree (CI sets its own)
const SECRET =
	process.env.OGYGIA_SECRET ?? '3f9a2b7c1e5d8046af62c93b1d7e4058a6c2f19b3e8d70425c9a1f6b8d3e07c4';
// adapter-node 6 takes the request's protocol from a header (default https): the test server is http
const PROTO = { 'x-forwarded-proto': 'http' };

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): boolean {
	return spawnSync(cmd, args, { stdio: 'inherit', ...opts }).status === 0;
}

/** Build + pack ogygia (and the core it re-exports), copy the fixture beside the tarballs, install it
 *  standalone (its own workspace root: @ogygia/tooling/e2e/packed.ts). */
function prepare(): void {
	expect(run('pnpm', ['run', 'build:lib'], { cwd: REPO }), 'ogygia build').toBe(true);
	rmSync(WORK, { recursive: true, force: true });
	mkdirSync(WORK, { recursive: true });
	const packed = pack_ogygia(WORK);
	cpSync(FIXTURE, APP, { recursive: true, filter: (src) => !COPY_SKIP_RE.test(src) });
	use_packed(APP, packed);
	// pnpm exits non-zero on unapproved native build scripts though the install completes: check by presence
	run('pnpm', ['install', '--no-lockfile', '--config.confirmModulesPurge=false'], {
		cwd: APP,
		env: { ...process.env, CI: '1' }
	});
	for (const dep of ['ogygia', 'vite', '@sveltejs/kit'])
		expect(existsSync(join(APP, 'node_modules', dep)), `installed ${dep}`).toBe(true);
	const kit = JSON.parse(
		readFileSync(join(APP, 'node_modules/@sveltejs/kit/package.json'), 'utf8')
	);
	expect(kit.version.startsWith('3.'), `Kit 3 installed (got ${kit.version})`).toBe(true);
}

/** One page of the lake: every island hydrated, the hole filled, each island working. */
async function exercise(page: Page, base: string, path: string, kit_page: boolean) {
	const errs: string[] = [];
	page.on('pageerror', (e) => errs.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error' || m.type() === 'warning') errs.push(`${m.type()}: ${m.text()}`);
	});
	await page.goto(base + path, { waitUntil: 'networkidle' });
	await sleep(500);
	const at = `${path}:`;
	check(
		`${at} every island in the lake hydrated`,
		(await page.locator('ogygia-region[data-hydrated]').count()) === 5
	);
	check(
		`${at} the kit-page thread is ${kit_page ? 'set' : 'absent'}`,
		(await page.evaluate(
			() => !!(globalThis as Record<symbol, unknown>)[Symbol.for('ogygia.kit-page')]
		)) === kit_page
	);
	check(`${at} the island reads this page`, (await page.textContent('[data-probe-path]')) === path);
	check(`${at} the hole filled`, (await page.locator('[data-hole-greeting]').count()) === 1);

	await page.click('[data-counter]');
	check(`${at} island interactive`, (await page.textContent('[data-counter]')) === 'count 1');

	// a custom transport type as a remote ARGUMENT, re-sent from the browser
	check(
		`${at} custom-type query argument (SSR)`,
		(await page.textContent('[data-point-sum]')) === '5'
	);
	await page.click('[data-point-bump]');
	await expect.poll(() => page.textContent('[data-point-sum]')).toBe('6');

	// the remote form: submit → Kit 3's form calls refreshAll → the island's query refreshes, no reload
	const stamp = await stamp_document(page);
	const before = (await page.locator('[data-items] li').allTextContents()).length;
	const text = `item-${path.length}-${Date.now() % 1000}`;
	await page.fill('[data-item-input]', text);
	await page.click('[data-item-submit]');
	await expect.poll(() => page.locator('[data-items] li').allTextContents()).toContain(text);
	check(
		`${at} the form refreshed the query (one more item)`,
		(await page.locator('[data-items] li').count()) === before + 1
	);
	check(`${at} the submit did not reload the page`, (await document_stamp(page)) === stamp);

	if (kit_page) {
		await page.click('[data-kit-btn]');
		check(
			`${at} Kit's own client is alive next to the lake`,
			(await page.textContent('[data-kit-btn]')) === 'kit:1'
		);
	}
	check(`${at} no errors or warnings`, errs.length === 0, errs.slice(0, 3).join(' | '));
}

test.describe('SvelteKit 3: build + dev on the packed ogygia (self-building fixture)', () => {
	test.describe.configure({ mode: 'serial' });
	test.beforeAll(() => {
		test.setTimeout(10 * 60_000);
		prepare();
	});

	test('production build: builds, islands hydrate on csr=false and csr=true pages, remote form refreshes', async ({
		browser
	}) => {
		test.setTimeout(5 * 60_000);
		const env = { ...process.env, OGYGIA_SECRET: SECRET };
		expect(run('pnpm', ['run', 'build'], { cwd: APP, env }), 'Kit 3 production build').toBe(true);
		const base = `http://127.0.0.1:${BUILD_PORT}`;
		let srv: SpawnedServer | undefined;
		try {
			srv = await spawn_server({
				cmd: 'node',
				args: ['build/index.js'],
				cwd: APP,
				env: {
					PORT: String(BUILD_PORT),
					HOST: '127.0.0.1',
					PROTOCOL_HEADER: 'x-forwarded-proto',
					OGYGIA_SECRET: SECRET
				},
				url: base + '/'
			});
			const context = await browser.newContext({ extraHTTPHeaders: PROTO });
			await exercise(await context.newPage(), base, '/', false);
			await exercise(await context.newPage(), base, '/kit', true);
			await context.close();
		} finally {
			srv?.kill();
		}
	});

	test('dev: islands hydrate on csr=false and csr=true pages, remote form refreshes', async ({
		browser
	}) => {
		test.setTimeout(5 * 60_000);
		const base = `http://127.0.0.1:${DEV_PORT}`;
		let srv: SpawnedServer | undefined;
		try {
			srv = await spawn_server({
				cmd: 'node',
				args: [
					'node_modules/vite/bin/vite.js',
					'dev',
					'--host',
					'127.0.0.1',
					'--port',
					String(DEV_PORT),
					'--strictPort'
				],
				cwd: APP,
				env: { OGYGIA_SECRET: SECRET },
				url: base + '/',
				timeout_ms: 120_000
			});
			// warm both pages first: dev discovers island deps on first render (one re-optimize)
			await fetch(base + '/');
			await fetch(base + '/kit');
			await sleep(1500);
			const context = await browser.newContext();
			await exercise(await context.newPage(), base, '/', false);
			await exercise(await context.newPage(), base, '/kit', true);
			await context.close();
		} finally {
			srv?.kill();
		}
	});
});
