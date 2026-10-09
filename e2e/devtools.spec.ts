// DEVTOOLS EVENT LAYER — the proof-of-value (internal/notes/devtools.md, Rung 0): the same
// interaction-island lifecycle that e2e/interaction.ts asserts by POLLING the DOM behind fixed
// `waitForTimeout`s, re-asserted by AWAITING typed events off the bus. No sleeps, no races — we
// wait for `wake.fired` / `interaction.replay` / `region.hydrate.done` to actually arrive.
//
// Devtools is dev-only (a build never carries it), so this spec boots its OWN playground dev server
// with OGYGIA_DEVTOOLS=1. The panel lives in a shadow root on <html>: Playwright's locators pierce
// it; the in-page reads go through `__dt_q` / `__dt_qa` (an init script) for the same reason.
//
//   pnpm exec playwright test devtools
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { test, check } from './fixtures/index.ts';
import { spawn_server, type SpawnedServer } from './fixtures/servers.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const playground = join(repo, 'apps', 'playground');
const PORT = 3084;
const base = `http://127.0.0.1:${PORT}`;
let srv: SpawnedServer | null = null;

test.use({ baseURL: base });
test.beforeAll(async () => {
	srv = await spawn_server({
		cmd: 'pnpm',
		// (`--force`: a cold dep optimizer every run, the case that bit — a dependency found late
		// re-optimized and reloaded the page, closing a dock just opened; the first test checks none is)
		args: ['--dir', playground, 'dev', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1', '--force'],
		cwd: repo,
		env: { OGYGIA_DEVTOOLS: '1', ORIGIN: base },
		url: `${base}/interaction`,
		timeout_ms: 120_000
	});
});
test.afterAll(() => srv?.kill());
test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		const root = () => document.querySelector('[data-ogygia-devtools-host]')?.shadowRoot ?? document;
		(window as any).__dt_q = (s: string) => root().querySelector(s);
		(window as any).__dt_qa = (s: string) => root().querySelectorAll(s);
	});
});

// Node-side probes. Regexes inside `page.evaluate(...)` callbacks run IN THE BROWSER and cannot
// reference these — they stay inline there.
const TIP_FP_RE = /fp/;
const TIP_PROPS_RE = /props/;
const TIP_SERVER_RENDERED_RE = /server-rendered/;
const KB_RE = /kB/;
const TIMELINE_RE = /timeline/;

/** Minimal shape of the events we assert on (mirrors src/devtools/schema.ts). */
type DtEvent = { domain: string; name: string; seq: number } & Record<string, unknown>;

/** Is `window.__ogygia_devtools` present (i.e. the served build compiled devtools in)? */
async function devtools_present(page: Page): Promise<boolean> {
	return page.evaluate(() => typeof (window as any).__ogygia_devtools !== 'undefined');
}

/** Read the whole event buffer. */
async function events(page: Page): Promise<DtEvent[]> {
	return page.evaluate(() => (window as any).__ogygia_devtools.events());
}

/** Wait (event-driven, bounded) until an event matching `pred` is buffered; returns it or null. */
async function wait_for_event(
	page: Page,
	pred: (e: DtEvent) => boolean,
	timeout = 4000
): Promise<DtEvent | null> {
	const found = await page
		.waitForFunction(
			// serialize the predicate as a string so it runs in-page
			(predSrc: string) => {
				const p = new Function('e', `return (${predSrc})(e)`) as (e: unknown) => boolean;
				const hook = (window as any).__ogygia_devtools;
				if (!hook) return false;
				const hit = hook.events().find(p);
				return hit ?? false;
			},
			pred.toString(),
			{ timeout }
		)
		.catch(() => null);
	return found ? ((await found.jsonValue()) as DtEvent) : null;
}

test.describe('devtools (dev server, OGYGIA_DEVTOOLS=1): events, panel tabs, page view', () => {
	test('a cold dev server: opening the dock and its tabs finds no dependency late (no re-optimize, no reload)', async ({ page }) => {
		// from the first visit on: the dev server's startup optimized everything a page and the dock
		// import (the app's code by its crawl, ogygia's client and dock deps by its include list), so
		// nothing may be found late — not by the page's first load (the dock's code loads with it),
		// not by opening the dock
		const from = srv!.logs.join('').length;
		let navs = 0;
		page.on('framenavigated', (f) => f === page.mainFrame() && navs++);
		await page.goto('/interaction', { waitUntil: 'load' });
		await page.waitForTimeout(2500);
		navs = 0;
		await page.click('[data-og-panel-toggle]');
		const open = await page.locator('[data-og-win]').waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
		for (const t of await page.locator('[data-og-tab]').all()) {
			await t.click().catch(() => {});
			await page.waitForTimeout(250);
		}
		await page.waitForTimeout(2500);
		const late = srv!.logs
			.join('')
			.slice(from)
			.split('\n')
			.filter((l) => l.includes('optimized dependencies changed') || l.includes('dependency optimized') || l.includes('dependencies optimized'));
		check('the dock opened, and stayed open through every tab', open && (await page.locator('[data-og-win]').count()) === 1);
		check('no reload while the dock was open', navs === 0, `${navs} reload(s)`);
		check('no dependency found late', late.length === 0, late.slice(0, 3).join(' | '));
	});

	test('schema, server realm, panel tabs, event-driven wake/replay, identity spine, nav, trace, timeline', async ({
		page
	}) => {
		await page.goto('/interaction', { waitUntil: 'load' });

		check('the devtools dev server publishes window.__ogygia_devtools', await devtools_present(page));

		// ── schema handshake ──────────────────────────────────────────────────────
		const version = await page.evaluate(() => (window as any).__ogygia_devtools.version);
		check('schema: window hook exposes a version', typeof version === 'number', `v${version}`);

		// ── runtime.boot names the features this build shipped ────────────────────
		const boot = await wait_for_event(page, (e) => e.name === 'runtime.boot');
		check('boot: runtime.boot emitted', !!boot);
		check(
			'boot: features list includes interaction (the page uses wake:interaction)',
			Array.isArray(boot?.features) && (boot!.features as string[]).includes('interaction'),
			JSON.stringify(boot?.features)
		);

		// ── SERVER REALM: the handle's side-channel folds server events into the SAME stream ──
		const all0 = await events(page);
		const serverEvents = all0.filter((e) => e.realm === 'server');
		check(
			'server: events present in the unified stream (realm=server)',
			serverEvents.length > 0,
			`${serverEvents.length} server events`
		);
		const serverRendered = serverEvents.filter((e) => e.name === 'server.region.rendered');
		check(
			'server: server.region.rendered (fp + mode + propsBytes)',
			serverRendered.length > 0 &&
				typeof serverRendered[0].fp === 'string' &&
				typeof serverRendered[0].propsBytes === 'number',
			`${serverRendered.length} rendered, sample propsBytes=${serverRendered[0]?.propsBytes}`
		);
		// (a seed ships only when an island reads the page — so the event must match the document)
		const has_seed = await page.evaluate(() => !!document.querySelector('script[data-ogygia-page], script[data-ogygia-remote]'));
		check(
			'server: a seed event exactly when the page carries a seed',
			serverEvents.some((e) => e.name === 'server.seed.injected') === has_seed,
			`seed script ${has_seed}`
		);

		// ── DEVTOOLS PANEL: one mounted Svelte app — launcher opens a tabbed window (Lens/Bytes/Timeline) ──
		// (a locator, not a handle: the launcher is drawn again when the dock's code arrives, and a held
		// handle to the first one is detached by then — a slow CI runner clicked a removed button)
		const launcher = page.locator('[data-og-panel-toggle]');
		const has_launcher = (await launcher.count()) > 0;
		check('panel: single launcher button is present on a devtools build', has_launcher);
		if (has_launcher) {
			await launcher.click(); // open the window (the dock's code may still be loading: it opens when in)
			const winOpen = await page
				.locator('[data-og-win]')
				.waitFor({ timeout: 10_000 })
				.then(() => true)
				.catch(() => false);
			check('panel: window opens with tabs', winOpen);

			// ── Lens tab (default): show the overlay → one tinted box per region; hover fuses DOM + bus ──
			await page.click('[data-og-tab="lens"]');
			await page.click('[data-og-overlay-toggle]');
			await page.waitForTimeout(200);
			const regionCount = await page.locator('ogygia-region').count();
			const boxes = await page.evaluate(() => (window as any).__dt_qa('[data-og-box]').length);
			check(
				'lens: one overlay box per rendered region',
				boxes === regionCount,
				`${boxes} boxes / ${regionCount} regions`
			);
			const island = await page.$('ogygia-region[wake="load"]');
			if (island) await island.hover();
			await page.waitForTimeout(150);
			const tip = await page.evaluate(() => {
				const t = (window as any).__dt_q('[data-og-overlay] + .tip, .tip');
				return t && getComputedStyle(t).display !== 'none' ? t.textContent || '' : '';
			});
			check(
				'lens: hover tooltip fuses server props + client hydrate (by fp)',
				TIP_FP_RE.test(tip) && TIP_PROPS_RE.test(tip) && TIP_SERVER_RENDERED_RE.test(tip),
				tip.slice(0, 80)
			);
			await page.click('[data-og-overlay-toggle]'); // hide the overlay again

			// ── Bytes tab: real over-the-wire JS sizes per island + a page total ──
			await page.click('[data-og-tab="bytes"]');
			await page.waitForTimeout(200);
			const led = await page.evaluate(() => {
				const win = (window as any).__dt_q('[data-og-win]');
				if (!win) return null;
				const rows = win.querySelectorAll('tbody tr').length;
				const total = win.querySelector('tfoot td:nth-child(3)')?.textContent || '';
				const hasRuntime = /ogygia runtime/.test(win.textContent || '');
				return { rows, total, hasRuntime };
			});
			check(
				'bytes: table opens with rows + a page total',
				!!led && led.rows > 0 && KB_RE.test(led.total),
				JSON.stringify(led)
			);
			check('bytes: accounts for the shared runtime chunk', !!led && led.hasRuntime);

			// ── Wire tab: what the server shipped (props payloads + seeds), with a data total ──
			await page.click('[data-og-tab="wire"]');
			await page.waitForTimeout(150);
			const wire = await page.evaluate(() => {
				const win = (window as any).__dt_q('[data-og-win]');
				if (!win) return null;
				const text = win.textContent || '';
				const rows = win.querySelectorAll('tbody tr').length;
				return {
					rows,
					hasProps: /props payload/.test(text),
					hasTotal: /data across the wire/.test(text)
				};
			});
			check(
				'wire: shows server crossings (props payload) + a data total',
				!!wire && wire.rows > 0 && wire.hasProps && wire.hasTotal,
				JSON.stringify(wire)
			);

			// ── Hub tab (no shared state on /interaction → the empty-state hint renders) ──
			await page.click('[data-og-tab="hub"]');
			await page.waitForTimeout(150);
			const hubEmpty = await page.evaluate(() => {
				const win = (window as any).__dt_q('[data-og-win]');
				return win
					? /hub inspector/.test(win.textContent || '') &&
							/no hub activity/.test(win.textContent || '')
					: false;
			});
			check('hub: tab renders; empty-state hint on a page with no shared state', hubEmpty);
		}

		// ── the eager load island wakes on its own (no interaction) ───────────────
		const loadWake = await wait_for_event(
			page,
			(e) => e.name === 'wake.fired' && (e as any).when === 'load'
		);
		check('load island: wake.fired(when=load) arrived', !!loadWake);
		const loadHydrated = await wait_for_event(page, (e) => e.name === 'region.hydrate.done');
		check(
			'load island: region.hydrate.done arrived (with ms)',
			typeof loadHydrated?.ms === 'number',
			`ms=${loadHydrated?.ms}`
		);

		// ── the interaction island is COLD: no wake.fired for it before we touch it ─
		// (its region.connected fires, but wake only "schedules" — the note's whole point.)
		const before = await events(page);
		const interactionConnected = before.find(
			(e) => e.name === 'region.connected' && (e as any).wake === 'interaction'
		);
		check('interaction: region.connected(wake=interaction) present', !!interactionConnected);
		const wokeInteractionEarly = before.some(
			(e) => e.name === 'wake.fired' && (e as any).when === 'interaction'
		);
		check('interaction: NOT woken before use (no wake.fired yet)', !wokeInteractionEarly);

		// ── click wakes it; assert on interaction.replay, not a sleep ─────────────
		await page.locator('[data-i-btn]').click();
		const replay = await wait_for_event(page, (e) => e.name === 'interaction.replay');
		check('interaction: interaction.replay arrived after the click', !!replay);
		check(
			'interaction: EXACTLY one click replayed (counts once)',
			replay?.clicks === 1,
			`clicks=${replay?.clicks}`
		);
		const interactionHydrated = await wait_for_event(
			page,
			(e) => e.name === 'region.hydrate.done' && !!(e as any).fp
		);
		check('interaction: region.hydrate.done arrived', !!interactionHydrated);

		// ── THE IDENTITY SPINE: a server render fp === the client wake fp for the SAME region ──
		const allNow = await events(page);
		const serverFps = new Set(
			allNow
				.filter((e) => e.realm === 'server' && e.name === 'server.region.rendered')
				.map((e) => e.fp)
				.filter(Boolean)
		);
		const clientFps = new Set(
			allNow
				.filter((e) => e.realm === 'client' && e.name === 'region.hydrate.done')
				.map((e) => e.fp)
				.filter(Boolean)
		);
		const correlated = [...clientFps].filter((fp) => serverFps.has(fp));
		check(
			'spine: a server render fp matches a client hydrate fp (same region, both realms)',
			correlated.length > 0,
			`correlated ${correlated.length} (server ${serverFps.size}, client ${clientFps.size})`
		);

		// The DOM agrees with the events — the island really did count exactly once.
		check(
			'interaction: DOM count is 1 (event story matches the page)',
			(await page.locator('[data-i-count]').innerText()) === '1'
		);

		// ── nav domain: navigate home, assert nav.start/finish + reconcile decisions ─
		const evBeforeNav = (await events(page)).length;
		await page.locator('nav a[href="/"]').click();
		const navFinish = await wait_for_event(
			page,
			(e) => e.name === 'nav.finish' && (e as any).to === '/'
		);
		check('nav: nav.finish(to=/) arrived', !!navFinish);
		check(
			'nav: finish carries a ms timing',
			typeof navFinish?.ms === 'number',
			`ms=${navFinish?.ms}`
		);
		// the Page tab follows the navigation: its report covers this page from the nav on
		const page_nav = await page.evaluate(() => (window as any).__ogygia_page?.()?.nav?.to ?? null);
		check('page view: knows the in-app navigation and reports from it', page_nav === '/', String(page_nav));
		const afterNav = await events(page);
		const navStart = afterNav.find((e) => e.name === 'nav.start' && (e as any).to === '/');
		check(
			'nav: nav.start emitted before finish',
			!!navStart && navStart.seq < (navFinish as DtEvent).seq
		);
		const reconciles = afterNav.filter((e) => e.name === 'nav.reconcile' && e.seq >= evBeforeNav);
		check(
			'nav: per-region reconcile decisions emitted (keep/patch/mount/remove)',
			reconciles.length > 0,
			reconciles.map((r) => (r as any).decision).join(',') || 'none'
		);

		// ── Nav tab: the panel shows the last nav's per-region decisions + timing ──
		{
			const open = await page.evaluate(() => !!(window as any).__dt_q('[data-og-win]'));
			if (!open) await page.click('[data-og-panel-toggle]');
			await page.click('[data-og-tab="nav"]');
			await page.waitForTimeout(150);
			const nav = await page.evaluate(() => {
				const win = (window as any).__dt_q('[data-og-win]');
				if (!win) return null;
				const text = win.textContent || '';
				const rows = win.querySelectorAll('tbody tr').length;
				return { rows, hasDecisions: /decision/.test(text), hasTiming: /ms/.test(text) };
			});
			check(
				'nav-lab: tab shows the last nav decisions + timing',
				!!nav && nav.rows > 0 && nav.hasDecisions && nav.hasTiming,
				JSON.stringify(nav)
			);
		}

		// ── trace: the buffer serializes to a portable, versioned, JSON-safe artifact ─
		const trace = await page.evaluate(() => {
			const t = (window as any).__ogygia_devtools.trace();
			return {
				kind: t.kind,
				version: t.version,
				count: t.events.length,
				json: JSON.stringify(t).length
			};
		});
		check(
			'trace: kind + version + non-empty + JSON-serializable',
			trace.kind === 'ogygia-devtools-trace' &&
				trace.version >= 1 &&
				trace.count > 0 &&
				trace.json > 0,
			`${trace.count} events, ${trace.json}B`
		);

		// ── Timeline tab: client wake/hydrate events laid on a time axis (open the panel + switch tab) ──
		const tlLauncher = await page.$('[data-og-panel-toggle]');
		if (tlLauncher) {
			// ensure the window is open, then select the Timeline tab
			const isOpen = await page.evaluate(() => !!(window as any).__dt_q('[data-og-win]'));
			if (!isOpen) await tlLauncher.click();
			await page.click('[data-og-tab="timeline"]');
			await page.waitForTimeout(250);
			const tl = await page.evaluate(() => {
				const win = (window as any).__dt_q('[data-og-win]');
				if (!win) return null;
				const dots = win.querySelectorAll('.dot[title*="@ +"]').length;
				const head = win.querySelector('.body h3')?.textContent || '';
				return { dots, head };
			});
			check(
				'timeline: tab plots client wake/hydrate events on the axis',
				!!tl && tl.dots > 0 && TIMELINE_RE.test(tl.head),
				JSON.stringify(tl)
			);
		}
	});

	// ── Hub tab, POPULATED: /transportable shares one wired instance across islands → reunions ──
	test('hub: populated — /transportable shows a shared instance reunited across islands', async ({
		page
	}) => {
		await page.goto('/transportable', { waitUntil: 'load' });
		await page.waitForTimeout(500);
		check('devtools present', await devtools_present(page));

		await page.click('[data-og-panel-toggle]');
		await page.click('[data-og-tab="hub"]');
		await page.waitForTimeout(250);
		const hub = await page.evaluate(() => {
			const win = (window as any).__dt_q('[data-og-win]');
			if (!win) return null;
			const rows = win.querySelectorAll('tbody tr').length;
			const reunions = /1 instance/.test(win.textContent || '');
			return { rows, reunions };
		});
		check(
			'hub: /transportable shows a shared instance reunited across islands',
			!!hub && hub.rows > 0 && hub.reunions,
			JSON.stringify(hub)
		);
	});

	// ── Profiler tab: native (no iframe) — a run lands in the dock, joins the island on the page ──
	test('profiler: a run renders natively and its island rows open the island detail', async ({ page }) => {
		test.setTimeout(120_000);
		await page.goto('/interaction', { waitUntil: 'load' });
		await page.click('[data-og-panel-toggle]');
		await page.click('[data-og-tab="profiler"]');
		check('profiler tab: no iframe', (await page.locator('[data-og-profiler] iframe').count()) === 0);
		await page.locator('[data-og-profiler] input.n').fill('2');
		const log_from = srv!.logs.join('').length;
		await page.click('[data-og-profile-run]');
		// (a rare miss in full runs: the profiler answered 200 and the head never drew — say what the
		// dock showed and what the server logged, so the next one names its cause)
		const drew = await page
			.locator('[data-og-profile-head]')
			.waitFor({ timeout: 100_000 })
			.then(() => true)
			.catch(() => false);
		if (!drew) {
			const dock = (await page.locator('[data-og-profiler]').innerText().catch(() => '(no dock)')).slice(0, 300);
			const logged = srv!.logs
				.join('')
				.slice(log_from)
				.split('\n')
				.filter((l) => /reload|optimiz|error/i.test(l))
				.slice(0, 5)
				.join(' | ');
			check('profiler tab: the run drew its head', false, `dock: ${dock} — server: ${logged || '(nothing)'} — url: ${page.url()}`);
			return;
		}
		check('profiler tab: the render time shows', /server render/.test(await page.locator('[data-og-profile-head]').innerText()));
		const rows = page.locator('[data-og-profile-islands] tbody tr.here');
		check('profiler tab: island rows joined to islands on this page', (await rows.count()) > 0);
		// the profile pointed at the page: a component's elements light up on hover
		const anchor = page.locator('[data-og-profile-anchors] button').first();
		check('profiler tab: costs with a place on the page are listed', (await anchor.count()) > 0);
		if (await anchor.count()) {
			await anchor.hover();
			await page.waitForTimeout(300);
			const boxes = await page.evaluate(() => (window as any).__dt_qa('[data-og-highlight] > div').length);
			check('profiler tab: hovering one lights its elements up on the page', boxes > 0, String(boxes));
		}
		await rows.first().click();
		await page.waitForTimeout(900);
		const server = await page.locator('[data-og-detail-server]').innerText().catch(() => '');
		check('island detail: shows the last profile\'s server numbers', /render/.test(server), server.slice(0, 100));
	});

	// ── Record + Hydration tabs: a session's findings point at the page; every island's hydration status ──
	test('record: a session finds the slow click and names its handler; hydration lists each island', async ({ page }) => {
		test.setTimeout(90_000);
		await page.goto('/dt-session', { waitUntil: 'load' });
		await page.waitForTimeout(9000); // past the load sampler (one sampler at a time)
		await page.click('[data-og-panel-toggle]');
		await page.click('[data-og-tab="record"]');
		await page.click('[data-og-session-start]');
		await page.click('[data-ds="slow"]');
		await page.click('[data-ds="dead"]');
		await page.waitForTimeout(800);
		await page.click('[data-og-session-stop]');
		await page.locator('[data-og-session-findings]').waitFor({ timeout: 10_000 });
		const report = await page.evaluate(() => (window as any).__ogygia_session);
		const slow = report?.findings.find((f: any) => f.code === 'slow-interaction');
		check('record: the slow click is found, in its island', !!slow && slow.message.includes('SessionSlow'), slow?.message ?? 'none');
		check('record: a click that did nothing is found', !!report?.findings.find((f: any) => f.code === 'dead-click' && f.message.includes('dead')));
		const chip = page.locator('[data-og-session-findings] li[data-code="slow-interaction"] .chip');
		if (await chip.count()) {
			await chip.click();
			await page.waitForTimeout(300);
			check('record: "show on the page" lights the clicked element', (await page.evaluate(() => (window as any).__dt_qa('[data-og-highlight] > div').length)) > 0);
		}

		await page.goto('/dt-lab', { waitUntil: 'load' });
		await page.waitForTimeout(2000);
		if (!(await page.locator('[data-og-tab="hydration"]').count())) await page.click('[data-og-panel-toggle]');
		await page.click('[data-og-tab="hydration"]');
		await page.waitForTimeout(600);
		const status = Object.fromEntries(
			await page.locator('[data-og-hydration] tr[data-status]').evaluateAll((rs) => rs.map((r) => [r.querySelector('.nm')?.firstChild?.textContent ?? '', r.getAttribute('data-status')]))
		);
		check('hydration: the island that throws is failed', status.Broken === 'failed', JSON.stringify(status));
		check('hydration: the island whose markup differs is changed', status.Clock === 'changed');
		check('hydration: a healthy island is clean', status.Healthy === 'clean');
		await page.locator('[data-og-hydration] tr[data-status="changed"]').first().click();
		await page.waitForTimeout(300);
		const diff = await page.locator('[data-og-hydration] .diffrow').innerText().catch(() => '');
		check('hydration: a changed island shows the difference', diff.includes('server') && diff.includes('browser'), diff.slice(0, 120));
	});

	// ── Page tab: the browser's view of the visit (the beacon, read live) on the planted lab ──
	// (the full grading, with repeats, is internal/bench/devtools-answer-key.mjs)
	test('page: the lab page\'s planted problems are found, pinned on their islands, and shown', async ({ page }) => {
		test.setTimeout(60_000);
		await page.goto('/dt-lab', { waitUntil: 'load' });
		await page.waitForTimeout(3500);
		const view = await page.evaluate(() => {
			const v = (window as any).__ogygia_page?.();
			if (!v) return null;
			const name = new Map(v.regions.map((r: any) => [r.fp, r.name]));
			return {
				findings: v.report.findings.map((f: any) => ({ code: f.code, names: f.fps.map((fp: string) => name.get(fp)) })),
				rows: v.report.rows.length,
				vitals: v.report.vitals.map((x: any) => x.key)
			};
		});
		check('page: window.__ogygia_page answers', !!view);
		const named = (code: string, island: string) => !!view?.findings.some((f) => f.code === code && f.names.includes(island));
		check('page: markup changed on hydration → Clock', named('markup-changed', 'Clock'), JSON.stringify(view?.findings));
		check('page: long hydrate → Heavy', named('long-hydrate', 'Heavy'));
		check('page: failed hydration → Broken', named('hydrate-failed', 'Broken'));
		check('page: eager island below the fold → BelowEager', named('eager-offscreen', 'BelowEager'));
		check('page: layout shift on waking → Grower', named('hydration-shift', 'Grower'));
		check(
			'page: no finding names a decoy',
			!view?.findings.some((f) => f.code !== 'queued' && f.names.some((n: string) => ['Healthy', 'BelowLazy', 'OnClick'].includes(n)))
		);
		check('page: an island row per hydration', (view?.rows ?? 0) >= 4, String(view?.rows));
		check('page: vitals measured (TTFB, FCP)', !!view?.vitals.includes('ttfb') && view.vitals.includes('fcp'), JSON.stringify(view?.vitals));

		await page.click('[data-og-panel-toggle]');
		await page.click('[data-og-tab="page"]');
		await page.waitForTimeout(900);
		const shown = await page.locator('[data-og-page-findings] li[data-code]').evaluateAll((els) => els.map((e) => e.getAttribute('data-code')));
		check('page tab: renders every finding', !!view && view.findings.every((f) => shown.includes(f.code)), shown.join(','));
		check('page tab: vitals row renders', (await page.locator('[data-og-vitals] .vital').count()) > 0);
		// a finding's island chip opens the island detail, with its browser numbers
		await page.locator('[data-og-page-findings] li[data-code="long-hydrate"] .chip').first().click();
		await page.waitForTimeout(900);
		const detail = await page.locator('[data-og-detail-browser]').innerText().catch(() => '');
		check('island detail: shows what the browser measured', detail.includes('hydrate step'), detail.slice(0, 120));
		// the island whose markup changed: its card names its own line that draws differently in the
		// browser (the dev server read its source)
		await page.locator('[data-og-detail] button.back').click();
		await page.waitForTimeout(400);
		await page.locator('[data-og-page-findings] li[data-code="markup-changed"] .chip').first().click();
		await page.waitForTimeout(900);
		const hazard = await page.locator('[data-og-detail-hazard]').innerText().catch(() => '');
		check('island detail: names the line that draws differently in the browser', hazard.includes('Clock.svelte:3') && hazard.includes('typeof window'), hazard.slice(0, 120));
	});

	test('twin islands (one fingerprint, two elements) and a Kit-hydrated page', async ({ page }) => {
		test.setTimeout(60_000);
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		// the same island with the same props, twice: one fingerprint on two elements — every tab
		// that lists islands must hold both (a list keyed by fingerprint threw each_key_duplicate)
		await page.goto('/props-tail', { waitUntil: 'load' });
		await page.waitForTimeout(1500);
		const twins = await page.evaluate(() => {
			const fps = [...document.querySelectorAll('ogygia-region[data-og-fp]')].map((e) => e.getAttribute('data-og-fp'));
			return fps.length - new Set(fps).size;
		});
		expect(twins, 'the page has twin islands').toBeGreaterThan(0);
		await page.click('[data-og-panel-toggle]');
		for (const tab of ['page', 'lens', 'hydration']) {
			await page.click(`[data-og-tab="${tab}"]`);
			await page.waitForTimeout(500);
		}
		const rows = await page.evaluate(() => (window as any).__dt_qa('[data-og-hydration] tr[data-status]').length);
		expect(errors).toEqual([]);
		expect(rows).toBeGreaterThan(1);
		// an island nested in an awake island rides its hydration (no data-hydrated of its own): it is
		// awake, and the Hydration tab says whose hydration it rode — never "asleep"
		await page.goto('/portable-snippet', { waitUntil: 'load' });
		await page.waitForTimeout(1500);
		const riding = await page.evaluate(async () => {
			const h = await (window as any).__ogygia_testing.hydration();
			return h.islands.filter((i: any) => i.reason.startsWith('rides ')).map((i: any) => i.status);
		});
		expect(riding, 'a riding island, awake').toEqual(['clean']);
		// a Kit-hydrated page with no island: the dock still mounts (its boot runs before Kit's client
		// hands the page the dev server's gates) and says why there is nothing to inspect
		await page.goto('/kit', { waitUntil: 'load' });
		await expect.poll(() => page.evaluate(() => !!document.querySelector('[data-ogygia-devtools-host]')), { timeout: 10_000 }).toBe(true);
		expect(errors).toEqual([]);
	});
});
