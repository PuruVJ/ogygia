// ogygia/testing, used the way an app's own Playwright suite would: `withOgygia(test, expect)`, then
// the `ogygia` fixture — page(), hydration(), record(), profile() — and the matchers. Against the
// playground's devtools dev server (its lab pages plant known problems, so each primitive has
// something real to find), with a deliberately failing matcher checked for a readable message.
//
//   pnpm exec playwright test ogygia-testing
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect as baseExpect } from '@playwright/test';
import { withOgygia, compare, toMarkdown, checkBudget } from '../packages/ogygia/dist/testing/index.js';
import { spawn_server, type SpawnedServer } from './fixtures/servers.ts';

const { test, expect } = withOgygia(base, baseExpect);

const repo = fileURLToPath(new URL('..', import.meta.url));
const playground = join(repo, 'apps', 'playground');
const PORT = 3086;
const origin = `http://127.0.0.1:${PORT}`;
let srv: SpawnedServer | null = null;

test.use({ baseURL: origin });
test.beforeAll(async () => {
	srv = await spawn_server({
		cmd: 'pnpm',
		args: ['--dir', playground, 'dev', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
		cwd: repo,
		env: { OGYGIA_DEVTOOLS: '1', ORIGIN: origin },
		url: `${origin}/dt-lab`,
		timeout_ms: 120_000
	});
});
test.afterAll(() => srv?.kill());

test('page() and hydration(): the planted problems, as a test sees them', async ({ page, ogygia }) => {
	test.setTimeout(90_000);
	await page.goto('/dt-lab');
	const load = await ogygia.page();
	const codes = load.findings.map((f) => f.code);
	expect(codes).toEqual(expect.arrayContaining(['hydrate-failed', 'markup-changed', 'long-hydrate']));
	expect(load.findings.find((f) => f.code === 'long-hydrate')!.names).toContain('Heavy');
	expect(load.islands.length).toBeGreaterThan(3);

	const hyd = await ogygia.hydration();
	const status = Object.fromEntries(hyd.islands.map((i) => [i.name, i.status]));
	expect(status.Broken).toBe('failed');
	expect(status.Clock).toBe('changed');
	expect(status.Healthy).toBe('clean');
	expect(hyd.islands.find((i) => i.name === 'Clock')!.diff!.added).toBeGreaterThan(0);

	// the matchers, and their messages when a test fails
	let message = '';
	try {
		expect(hyd).toHydrateCleanly();
	} catch (e) {
		message = (e as Error).message;
	}
	expect(message).toContain('Broken: failed');
	expect(message).toContain('Clock: changed');
	expect(hyd).toHydrateCleanly({ allow: ['failed', 'changed', 'healed'] });
	expect(load).toMeetBudget({ fcp: 10_000 });
	expect(checkBudget(load, { longTaskMs: 0 })[0].ok).toBe(false);
});

test('record(): a session of clicks, with the server split of the request one made', async ({ page, ogygia }) => {
	test.setTimeout(90_000);
	await page.goto('/dt-session');
	await page.waitForTimeout(9000); // past the page-load sampler (one sampler at a time)
	const session = await ogygia.record(
		async () => {
			await page.locator('[data-ds="decoy"]').click();
			await page.locator('[data-ds="slow"]').click();
			await page.locator('[data-ds="server"]').click();
			await page.waitForTimeout(800);
		},
		{ server: true }
	);
	// the server over the same stretch: the request the click made, and the upstream it called
	expect(session.server?.window.requests.map((r) => r.path)).toEqual(expect.arrayContaining(['/dt-session/api', '/hell/api/session']));
	expect(session).toMeetBudget({ serverBusyMs: 60_000 });
	const slow = session.findings.find((f) => f.code === 'slow-interaction');
	expect(slow?.message).toContain('SessionSlow');
	const server = session.findings.find((f) => f.code === 'server-time');
	expect(server?.message).toContain('/hell/api/session');
	expect(session).toMeetBudget({ errors: 0 });
	expect(() => expect(session).toHaveNoFindings({ severity: 'warn' })).toThrow(/slow-interaction/);
	expect(session).toHaveNoFindings({ severity: 'warn', ignore: ['slow-interaction'] });
	expect(session.timeline.length).toBeGreaterThan(0);
});

test('record() across a full page load: one session, both pages', async ({ page, ogygia }) => {
	test.setTimeout(90_000);
	await page.goto('/dt-session');
	await page.waitForTimeout(9000);
	const session = await ogygia.record(async () => {
		await page.locator('[data-ds="slow"]').click();
		await page.waitForTimeout(400);
		await page.goto('/dt-lab'); // a full document load mid-session (not the router)
		await page.waitForTimeout(2500);
		await page.locator('[data-dt="healthy"] button').click();
	});
	expect(session.counts.pages).toBe(2);
	// the first page's slow click keeps its island's name, the second page's broken island is there
	expect(session.findings.find((f) => f.code === 'slow-interaction')?.message).toContain('SessionSlow');
	expect(session.findings.find((f) => f.code === 'hydrate-failed')?.message).toContain('Broken');
});

test('record() across an in-app navigation: the first page keeps its island names', async ({ page, ogygia }) => {
	test.setTimeout(90_000);
	await page.goto('/dt-session');
	await page.waitForTimeout(9000);
	const session = await ogygia.record(async () => {
		await page.locator('[data-ds="slow"]').click();
		await page.waitForTimeout(400);
		// the router swaps the page (no document load): the first page's islands leave the DOM
		const soft = await page.evaluate(async () => {
			const nav = (globalThis as any)[Symbol.for('ogygia.nav')];
			const origin = performance.timeOrigin;
			await nav.goto('/dt-lab');
			return performance.timeOrigin === origin;
		});
		expect(soft, 'the router navigated without a page load').toBe(true);
		await page.waitForTimeout(2500);
		await page.locator('[data-dt="healthy"] button').click();
	});
	const slow = session.findings.find((f) => f.code === 'slow-interaction');
	expect(slow?.message).toContain('SessionSlow');
	// no finding names an island by its raw fingerprint
	for (const f of session.findings) expect(f.message, f.code).not.toMatch(/\b[0-9a-f]{16}\b/);
});

test('profile(): the server profile of a path, and compare() over two runs', async ({ page, ogygia }) => {
	test.setTimeout(120_000);
	await page.goto('/interaction');
	const a = await ogygia.profile('/interaction', { runs: 2 });
	expect(a.target.page).toBe('/interaction');
	expect(a.score).not.toBeNull();
	expect(a).toMeetBudget({ renderMs: 5_000 });

	// two "runs" of the same test (a CI base and head): what a PR comment would say
	const run = (reports: typeof ogygia.reports) => [{ test: 'profile', reports }];
	const head = structuredClone(a);
	head.findings = [...head.findings, { severity: 'warn', code: 'planted-new', message: 'a new problem' }];
	const diff = compare(run([a]), run([head]));
	expect(diff[0].findings.added.join()).toContain('planted-new');
	expect(toMarkdown(diff)).toContain('new: planted-new');
	expect(ogygia.reports.map((r) => r.kind)).toEqual(['profile']);
});
