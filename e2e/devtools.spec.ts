// DEVTOOLS EVENT LAYER — the proof-of-value (internal/notes/devtools.md, Rung 0): the same
// interaction-island lifecycle that e2e/interaction.ts asserts by POLLING the DOM behind fixed
// `waitForTimeout`s, re-asserted by AWAITING typed events off the bus. No sleeps, no races — we
// wait for `wake.fired` / `interaction.replay` / `region.hydrate.done` to actually arrive.
//
// Requires a build with `ogygia({ devtools: true })` (the playground reads OGYGIA_DEVTOOLS=1). When
// the served build has devtools OFF, `window.__ogygia_devtools` is absent (it tree-shook away) and
// every check SKIP-PASSES with a note — so this is safe in the default (devtools-off) suite too.
//
// Usage: OGYGIA_DEVTOOLS=1 pnpm exec playwright test devtools   (after a devtools-on build)
import type { Page } from '@playwright/test';
import { test, check } from './fixtures/index.ts';

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

test.describe('devtools event layer: event-driven interaction/nav/trace (skips if build has devtools off)', () => {
	test('schema, server realm, panel tabs, event-driven wake/replay, identity spine, nav, trace, timeline', async ({
		page
	}) => {
		await page.goto('/interaction', { waitUntil: 'load' });

		test.skip(
			!(await devtools_present(page)),
			'window.__ogygia_devtools absent — served build has devtools OFF (tree-shaken)'
		);

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
		check(
			'server: seed injected event present',
			serverEvents.some((e) => e.name === 'server.seed.injected')
		);

		// ── DEVTOOLS PANEL: one mounted Svelte app — launcher opens a tabbed window (Lens/Bytes/Timeline) ──
		const launcher = await page.$('[data-og-panel-toggle]');
		check('panel: single launcher button is present on a devtools build', !!launcher);
		if (launcher) {
			await launcher.click(); // open the window
			await page.waitForTimeout(150);
			const winOpen = await page.evaluate(() => !!document.querySelector('[data-og-win]'));
			check('panel: window opens with tabs', winOpen);

			// ── Lens tab (default): show the overlay → one tinted box per region; hover fuses DOM + bus ──
			await page.click('[data-og-tab="lens"]');
			await page.click('[data-og-overlay-toggle]');
			await page.waitForTimeout(200);
			const regionCount = await page.locator('ogygia-region').count();
			const boxes = await page.evaluate(() => document.querySelectorAll('[data-og-box]').length);
			check(
				'lens: one overlay box per rendered region',
				boxes === regionCount,
				`${boxes} boxes / ${regionCount} regions`
			);
			const island = await page.$('ogygia-region[wake="load"]');
			if (island) await island.hover();
			await page.waitForTimeout(150);
			const tip = await page.evaluate(() => {
				const t = document.querySelector('[data-og-overlay] + .tip, .tip');
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
				const win = document.querySelector('[data-og-win]');
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
				const win = document.querySelector('[data-og-win]');
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
				const win = document.querySelector('[data-og-win]');
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
			const open = await page.evaluate(() => !!document.querySelector('[data-og-win]'));
			if (!open) await page.click('[data-og-panel-toggle]');
			await page.click('[data-og-tab="nav"]');
			await page.waitForTimeout(150);
			const nav = await page.evaluate(() => {
				const win = document.querySelector('[data-og-win]');
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
			const isOpen = await page.evaluate(() => !!document.querySelector('[data-og-win]'));
			if (!isOpen) await tlLauncher.click();
			await page.click('[data-og-tab="timeline"]');
			await page.waitForTimeout(250);
			const tl = await page.evaluate(() => {
				const win = document.querySelector('[data-og-win]');
				if (!win) return null;
				const dots = win.querySelectorAll('.dot[title*="@ +"]').length;
				const head = win.querySelector('h4')?.textContent || '';
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
		test.skip(!(await devtools_present(page)), 'devtools off on this build');

		await page.click('[data-og-panel-toggle]');
		await page.click('[data-og-tab="hub"]');
		await page.waitForTimeout(250);
		const hub = await page.evaluate(() => {
			const win = document.querySelector('[data-og-win]');
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
});
