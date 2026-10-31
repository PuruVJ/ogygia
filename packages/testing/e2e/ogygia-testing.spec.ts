// @ogygia/testing, used the way an app's own Playwright suite would: `withOgygia(test, expect)`, then
// the `ogygia` fixture — page(), hydration(), record(), profile() — and the matchers. Against the
// devtools lab's dev server (packages/devtools/e2e/app: its lab pages plant known problems, so each
// primitive has something real to find), with a deliberately failing matcher checked for a readable
// message.
//
//   pnpm turbo run e2e --filter=@ogygia/testing
import { fileURLToPath } from 'node:url';
import { test as base, expect as baseExpect } from '@playwright/test';
import { REPO as repo } from '@ogygia/tooling/e2e';
import { spawn_server, type SpawnedServer } from '@ogygia/tooling/e2e/servers.ts';
import {
	withOgygia,
	compare,
	toMarkdown,
	checkBudget,
	createOgygia,
	playwrightDriver,
	turnOnDevtools
} from '../dist/index.js';

const { test, expect } = withOgygia(base, baseExpect);

const lab = fileURLToPath(new URL('../../devtools/e2e/app', import.meta.url));
const PORT = 3086;
const origin = `http://127.0.0.1:${PORT}`;
let srv: SpawnedServer | null = null;

test.use({ baseURL: origin });
test.beforeAll(async () => {
	srv = await spawn_server({
		cmd: 'pnpm',
		args: ['--dir', lab, 'dev', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
		cwd: repo,
		env: { OGYGIA_DEVTOOLS: '1', ORIGIN: origin },
		url: `${origin}/dt-lab`,
		timeout_ms: 120_000
	});
});
test.afterAll(() => srv?.kill());

test('page() and hydration(): the planted problems, as a test sees them', async ({
	page,
	ogygia
}) => {
	test.setTimeout(90_000);
	await page.goto('/dt-lab');
	const load = await ogygia.page();
	const codes = load.findings.map((f) => f.code);
	expect(codes).toEqual(
		expect.arrayContaining(['hydrate-failed', 'markup-changed', 'long-hydrate'])
	);
	expect(load.findings.find((f) => f.code === 'long-hydrate')!.names).toContain('Heavy');
	expect(load.islands.length).toBeGreaterThan(3);

	const hyd = await ogygia.hydration();
	const status = Object.fromEntries(hyd.islands.map((i) => [i.name, i.status]));
	expect(status.Broken).toBe('failed');
	expect(status.Clock).toBe('changed');
	expect(status.Healthy).toBe('clean');
	expect(hyd.islands.find((i) => i.name === 'Clock')!.diff!.added).toBeGreaterThan(0);
	// each instance keyed by its place among islands of its name (no `islandKey` attribute given)
	expect(hyd.islands.find((i) => i.name === 'Broken')!.key).toBe('Broken#1');
	// the clock renders other text in the browser: a markup change, not attributes; nothing touched it
	expect(hyd.islands.find((i) => i.name === 'Clock')).toMatchObject({
		attributesOnly: false,
		inputDuringHydration: false
	});
	// what measuring cost the page, for a test to subtract
	expect(load.self!.script_ms).toBeGreaterThan(0);
	expect(load.self!.phases.islands).toBeGreaterThan(0);
	expect(load.self!.bytes).toBeGreaterThan(0);
	expect(load.engine).toMatchObject({ version: 3, lean: false });
	expect(new Set(hyd.islands.map((i) => i.key)).size).toBe(hyd.islands.length);

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

test('record(): a session of clicks, with the server split of the request one made', async ({
	page,
	ogygia
}) => {
	test.setTimeout(90_000);
	await page.goto('/dt-session');
	await page.waitForTimeout(9000); // past the page-load sampler (one sampler at a time)
	const session = await ogygia.record(
		async () => {
			await page.locator('[data-ds="decoy"]').click();
			await page.locator('[data-ds="slow"]').click();
			// the session must span the request the click makes: wait for its answer, not a fixed time
			// (on a slow CI runner 800 ms ended the window before the request did — an empty server split)
			const answered = page.waitForResponse((r) => r.url().includes('/dt-session/api'));
			await page.locator('[data-ds="server"]').click();
			await answered;
			await page.waitForTimeout(300);
		},
		{ server: true }
	);
	// the server over the same stretch: the request the click made, and the upstream it called
	expect(session.server?.error).toBeUndefined();
	expect(session.server?.window?.requests.map((r) => r.path)).toEqual(
		expect.arrayContaining(['/dt-session/api', '/hell/api/session'])
	);
	expect(session).toMeetBudget({ serverBusyMs: 60_000 });
	const slow = session.findings.find((f) => f.code === 'slow-interaction');
	expect(slow?.message).toContain('SessionSlow');
	expect(slow?.names).toContain('SessionSlow');
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
	expect(session.findings.find((f) => f.code === 'slow-interaction')?.message).toContain(
		'SessionSlow'
	);
	expect(session.findings.find((f) => f.code === 'hydrate-failed')?.message).toContain('Broken');
});

test('record({ blockNavigation }): a click that would load another document is held back and listed', async ({
	page,
	ogygia
}) => {
	test.setTimeout(90_000);
	await page.goto('/dt-session');
	await page.waitForTimeout(9000);
	const origin = await page.evaluate(() => performance.timeOrigin);
	const session = await ogygia.record(
		async () => {
			await page.locator('[data-ds="slow"]').click();
			// a plain link out of the router's reach: a full document load
			await page.evaluate(() => {
				const a = Object.assign(document.createElement('a'), {
					href: '/dt-lab',
					textContent: 'leave'
				});
				a.setAttribute('data-sveltekit-reload', '');
				a.setAttribute('data-leave', '');
				document.body.append(a);
			});
			await page.locator('[data-leave]').click();
			await page.waitForTimeout(500);
		},
		{ blockNavigation: true }
	);
	expect(await page.evaluate(() => performance.timeOrigin), 'the page stayed').toBe(origin);
	expect(session.engine.version).toBe(3);
	expect(session.navigations).toHaveLength(1);
	expect(session.navigations[0].url).toContain('/dt-lab');
	expect(session.navigations[0]).toMatchObject({ approx: false });
	expect(session.navigations[0].after).toContain('leave');
	expect(session.findings.find((f) => f.code === 'navigation-blocked')?.message).toContain(
		'/dt-lab'
	);
});

test('a reload in a click handler is named by the button that ran it, run after run (the exported driver)', async ({
	page,
	baseURL
}) => {
	test.setTimeout(120_000);
	// (a caller holding its own pages: the driver withOgygia builds, with a hook on each held load)
	const held: string[] = [];
	await turnOnDevtools(page, baseURL);
	const og = createOgygia(
		playwrightDriver(page, { baseURL, onNavigationHeld: (n) => held.push(n.url) })
	);
	await page.goto('/dt-session');
	await page.waitForTimeout(9000);
	await page.evaluate(() => {
		const b = Object.assign(document.createElement('button'), { textContent: 'Login/Register' });
		b.setAttribute('data-login', '');
		b.onclick = () => location.reload();
		document.body.append(b);
		// an empty button beside it, clicked first: the input the old guess could pick
		const e = document.createElement('button');
		e.setAttribute('data-empty', '');
		document.body.append(e);
	});
	for (let run = 0; run < 3; run++) {
		const session = await og.record(
			async () => {
				await page.locator('[data-empty]').click();
				await page.locator('[data-login]').click();
				await page.locator('[data-empty]').click();
				await page.waitForTimeout(300);
			},
			{ blockNavigation: true }
		);
		expect(session.navigations, `run ${run}`).toHaveLength(1);
		expect(session.navigations[0], `run ${run}`).toMatchObject({ approx: false });
		expect(session.navigations[0].after, `run ${run}`).toContain('Login/Register');
	}
	expect(held).toHaveLength(3);
});

test('a router navigation handed to the browser and held back leaves page() on the same page', async ({
	page,
	ogygia
}) => {
	test.setTimeout(90_000);
	await page.goto('/dt-session');
	await page.waitForTimeout(9000);
	const before = await ogygia.page();
	expect(before.islands.length).toBeGreaterThan(0);
	await ogygia.record(
		async () => {
			// a link the router takes (no reload attribute) to a csr=true page: it starts a navigation,
			// pushes the address, then hands the load to the browser, which the test holds back
			await page.evaluate(() => {
				const a = Object.assign(document.createElement('a'), {
					href: '/head-budget-kit',
					textContent: 'to a kit page'
				});
				a.setAttribute('data-to-kit', '');
				document.body.append(a);
			});
			await page.locator('[data-to-kit]').click();
			await page.waitForTimeout(1500);
		},
		{ blockNavigation: true }
	);
	expect(
		await page.evaluate(() => location.pathname),
		'the router took the link (it pushed the address)'
	).toBe('/head-budget-kit');
	await ogygia.settled({ quiet: 500, timeout: 15_000 });
	const later = await ogygia.page();
	const hyd = await ogygia.hydration();
	// the page never changed: its islands are all still in page(), and hydration() carries their wake times
	expect(later.islands.length).toBeGreaterThanOrEqual(before.islands.length);
	const fps = new Set(later.islands.map((i) => i.fp));
	for (const i of hyd.islands.filter((x) => x.status !== 'asleep')) {
		expect(fps.has(i.fp), i.name).toBe(true);
		expect(typeof i.t0, i.name).toBe('number');
	}
});

test.describe('lean testing', () => {
	test.use({ ogygiaOptions: { lean: true } });
	test('the testing API in full, and nothing else of devtools: no launcher, no event side-channel', async ({
		page,
		ogygia
	}) => {
		test.setTimeout(60_000);
		const html = page.waitForResponse((r) => r.url().endsWith('/dt-lab')).then((r) => r.text());
		await page.goto('/dt-lab');
		const load = await ogygia.page();
		const hyd = await ogygia.hydration();
		expect(load.engine).toMatchObject({ version: 3, lean: true });
		expect(hyd.islands.find((i) => i.name === 'Broken')?.status).toBe('failed');
		expect(await page.locator('[data-ogygia-devtools-host]').count(), 'no launcher').toBe(0);
		expect(await html, 'no server event side-channel in the HTML').not.toContain(
			'application/ogygia-devtools'
		);
	});
});

test.describe('a recording whose page leaves for a document with no testing API', () => {
	test.use({ ogygiaOptions: { timeout: 1500 } });
	test('says the page left, with the actions’ own error as the cause', async ({ page, ogygia }) => {
		test.setTimeout(60_000);
		await page.goto('/dt-session');
		await page.waitForTimeout(2000);
		const boom = new Error('the button was gone');
		const err = (await ogygia
			.record(async () => {
				await page.goto('about:blank');
				throw boom;
			})
			.catch((e: Error) => e)) as Error;
		expect(err.message).toContain('went to another document');
		expect(err.message).not.toContain('plugins: [ogygia(), devtools(), sveltekit()]');
		expect(err.cause).toBe(boom);
	});
});

test('record() across an in-app navigation: the first page keeps its island names', async ({
	page,
	ogygia
}) => {
	test.setTimeout(90_000);
	await page.goto('/dt-session');
	await page.waitForTimeout(9000);
	const session = await ogygia.record(async () => {
		await page.locator('[data-ds="slow"]').click();
		await page.waitForTimeout(400);
		// the router swaps the page (no document load): the first page's islands leave the DOM
		const soft = await page.evaluate(async () => {
			const nav = (
				globalThis as unknown as Record<symbol, { goto(href: string): Promise<unknown> }>
			)[Symbol.for('ogygia.nav')];
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

test('profile(): the server profile of a path, and compare() over two runs', async ({
	page,
	ogygia
}) => {
	test.setTimeout(120_000);
	await page.goto('/interaction');
	const a = await ogygia.profile('/interaction', { runs: 2 });
	expect(a.target.page).toBe('/interaction');
	expect(a.score).not.toBeNull();
	expect(a).toMeetBudget({ renderMs: 5_000 });

	// two "runs" of the same test (a CI base and head): what a PR comment would say
	const run = (reports: typeof ogygia.reports) => [{ test: 'profile', reports }];
	const head = structuredClone(a);
	head.findings = [
		...head.findings,
		{ severity: 'warn', code: 'planted-new', message: 'a new problem' }
	];
	const diff = compare(run([a]), run([head]));
	expect(diff[0].findings.added.join()).toContain('planted-new');
	expect(toMarkdown(diff)).toContain('new: planted-new');
	expect(ogygia.reports.map((r) => r.kind)).toEqual(['profile']);
});
