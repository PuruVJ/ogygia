// THE DEVTOOLS PAGE TAB'S ANSWER KEY: load the playground's /dt-lab (every PLANTED island has one
// problem the browser can measure, every DECOY is healthy), act like a hurried visitor, and check
// the Page tab's report (`window.__ogygia_page()`, the same object the tab renders): each planted
// problem found and pinned on its island, no decoy named by anything.
//
// Against a dev server you started (devtools is dev-only):
//   cd apps/playground && OGYGIA_DEVTOOLS=1 node node_modules/vite/bin/vite.js dev --port 4183 --host 127.0.0.1
//   node internal/bench/devtools-answer-key.mjs [base=http://127.0.0.1:4183] [--repeat=3]
// Or let it start one:
//   node internal/bench/devtools-answer-key.mjs --serve [--repeat=3]
//
// With --repeat, a planted problem must be found in at least two runs of three (the early click is a
// race against the island's wake); a decoy must be quiet in every run. Exit code 1 on a failure.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
const serve = flags.includes('--serve');
const repeat = Math.max(1, Number(flag('repeat') ?? (serve ? 3 : 1)));
const PORT = 4188;
const base = args[0] ?? (serve ? `http://127.0.0.1:${PORT}` : 'http://127.0.0.1:4183');
const app = fileURLToPath(new URL('../../apps/playground', import.meta.url));
const { chromium } = createRequire(new URL('../../package.json', import.meta.url))('playwright');

/** finding code → the island it must name (null: a page-wide finding, named by nothing) */
const PLANTED = {
	'markup-changed': 'Clock',
	'hydration-shift': 'Grower',
	'long-hydrate': 'Heavy',
	'hydrate-failed': 'Broken',
	'early-click': 'LateClick',
	'eager-offscreen': 'BelowEager',
	'long-tasks': null
};
const DECOYS = ['Healthy', 'BelowLazy', 'OnClick'];
/** findings that name the islands that SUFFERED (a decoy may wait behind a planted island) */
const VICTIM = new Set(['queued']);

async function start_server() {
	const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'dev', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
		cwd: app,
		env: { ...process.env, OGYGIA_DEVTOOLS: '1', ORIGIN: base },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let log = '';
	child.stdout.on('data', (d) => (log += d));
	child.stderr.on('data', (d) => (log += d));
	for (let i = 0; i < 120; i++) {
		try {
			const r = await fetch(base + '/dt-lab');
			if (r.ok) return child;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	child.kill();
	throw new Error('dev server did not start:\n' + log.slice(-2000));
}

/** a profiler report of /dt-lab, recorded before the visit: the visit's beacon joins it, and the
 *  report's browser findings must say what the Page tab says (null: the profiler is off here) */
async function record_profile() {
	for (let i = 0; i < 10; i++) {
		const r = await fetch(`${base}/__profiler/page?p=/dt-lab&runs=1`, { redirect: 'manual' }).catch(() => null);
		if (!r || r.status === 404) return null;
		const id = r.headers.get('location')?.split('/').pop();
		if (id) return id;
		await new Promise((ok) => setTimeout(ok, 2000)); // 409: a background sample is running
	}
	return null;
}

async function one_run(browser) {
	const report_id = await record_profile();
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	await page.goto(base + '/dt-lab', { waitUntil: 'load' });
	// a beat first: the browser ignores layout shifts within 500 ms after input (rightly — the visitor
	// caused them), and the planted shift happens as the first islands wake
	await page.waitForTimeout(900);
	// the hurried visitor: straight to the island far down the page (it wakes on sight — the click
	// lands before it is awake), and a click on the interaction island (its click IS its wake)
	await page.locator('[data-dt="late-click"] button').click({ timeout: 5000 });
	await page.locator('[data-dt="on-click"] button').click({ timeout: 5000 });
	// the load CPU trace closes 8 s after boot: wait for it (the findings quote it)
	await page.waitForTimeout(3500);
	await page.waitForFunction(() => window.__ogygia_page?.()?.page.cpu.state !== 'recording', null, { timeout: 12_000 }).catch(() => {});
	const view = await page.evaluate(() => {
		const v = window.__ogygia_page?.();
		// every file the page loaded is counted (not the first 200, not the browser's 250-entry buffer)
		const files = { counted: v ? v.report.bytes.reduce((s, b) => s + b.count, 0) : 0, browser: performance.getEntriesByType('resource').filter((r) => !r.name.includes('/__profiler/')).length };
		return v ? { files, findings: v.report.findings, regions: v.regions, rows: v.report.rows, shifts: v.page.shifts, cpu: v.cpu ? { busy: v.cpu.busy_ms, kinds: v.cpu.by_kind } : null, cpu_off: v.page.cpu.off } : null;
	});
	// and the tab shows what the data says: open the panel on Page, count the rendered findings
	// (the layout is remembered per browser; open it only when it is closed)
	if (!(await page.locator('[data-og-tab="page"]').count())) await page.locator('[data-og-panel-toggle]').click();
	await page.locator('[data-og-tab="page"]').click();
	await page.waitForTimeout(900);
	const shown = await page.locator('[data-og-page-findings] li[data-code]').evaluateAll((els) => els.map((e) => e.getAttribute('data-code')));
	// THE HYDRATION TAB: each island's status (scroll the edited one into view so it wakes and heals)
	await page.locator('[data-dt="edited"]').scrollIntoViewIfNeeded();
	await page.waitForTimeout(800);
	await page.locator('[data-og-tab="hydration"]').click();
	await page.waitForTimeout(800);
	const hydration = Object.fromEntries(
		await page.locator('[data-og-hydration] tr[data-status]').evaluateAll((rs) => rs.map((r) => [r.querySelector('.nm')?.firstChild?.textContent ?? '', r.getAttribute('data-status')]))
	);
	await page.close({ runBeforeUnload: true }); // the page hides: the final visit goes out
	if (!view) throw new Error('window.__ogygia_page is missing: is this a devtools dev server?');
	let report = null;
	if (report_id)
		// (the visit arrives first; the CPU trace, cut by island, a few seconds later)
		for (let i = 0; i < 15 && !(report?.browser_findings?.length && report.by_island); i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
			if (j) report = { browser_findings: (j.findings ?? []).filter((f) => f.fps || f.code === 'long-tasks'), by_island: j.browser?.cpu?.by_island ?? null, client: (j.findings ?? []).find((f) => f.code === 'client-hydrate') ?? null };
		}
	return { ...view, shown, hydration, report };
}

/** THIRD PARTIES (/dt-third): its "other origin" is this server under its other loopback name. The
 *  Page tab and the profiler report must both name: the blocking script, the scripts loaded by a
 *  script (3), the main-thread time, the island a third party edited — and never the healthy one. */
async function third_run(browser) {
	let report_id = null;
	for (let i = 0; i < 10 && !report_id; i++) {
		const r = await fetch(`${base}/__profiler/page?p=/dt-third&runs=1`, { redirect: 'manual' }).catch(() => null);
		if (!r || r.status === 404) break;
		report_id = r.headers.get('location')?.split('/').pop() ?? null;
		if (!report_id) await new Promise((ok) => setTimeout(ok, 2000));
	}
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	await page.goto(base + '/dt-third', { waitUntil: 'load' });
	await page.waitForTimeout(4000);
	const view = await page.evaluate(() => {
		const v = window.__ogygia_page?.();
		return v ? { findings: v.report.findings.map((f) => ({ code: f.code, message: f.message })), tp: v.report.third_party } : null;
	});
	await page.close({ runBeforeUnload: true });
	let report = null;
	if (report_id)
		for (let i = 0; i < 10 && !report?.some((f) => f.code === 'third-party'); i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
			if (j) report = (j.findings ?? []).map((f) => ({ code: f.code, message: f.message }));
		}
	const grade_third = (label, findings) => {
		if (!findings) return console.log(`  · ${label}: nothing to grade`), 0;
		const has = (code, text) => findings.some((f) => f.code === code && (!text || f.message.includes(text)));
		const checks = [
			['blocking', has('third-party-blocking', 'localhost')],
			['loaded by scripts', has('third-party', '3 of their scripts')],
			['main-thread time', findings.some((f) => f.code === 'third-party' && /ran (\d+) ms/.test(f.message) && Number(/ran (\d+) ms/.exec(f.message)[1]) >= 100)],
			['edited island', has('third-party-edits', 'ThirdTarget')],
			// (the third-party findings never blame the healthy island; other lines may name it — its wake time)
			['decoy quiet', !findings.some((f) => f.code.startsWith('third-party') && f.message.includes('Healthy'))]
		];
		const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
		console.log(`  ${bad.length ? '✗' : '✓'} third parties in the ${label}: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}`);
		return bad.length ? 0 : 1;
	};
	return grade_third('Page tab', view?.findings) + grade_third('profiler report', report);
}

/** STYLES (/dt-styles): the planted unscoped fallback (LabCard.svelte, in leak.css) and the 600
 *  rules that match nothing (unused.css) must be named; the healthy island's scoped styles never.
 *  And a page with nothing planted (/dt-lab) must raise neither. */
async function styles_run(browser) {
	const read = async (path) => {
		const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		await page.goto(base + path, { waitUntil: 'load' });
		await page.waitForTimeout(1500);
		const s = await page.evaluate(async () => {
			const r = await window.__ogygia_styles?.();
			return r ? { findings: r.findings.map((f) => ({ code: f.code, message: f.message })), unscoped: r.report.unscoped.map((u) => u.file), sheets: r.report.sheets.map((x) => ({ label: x.label, unmatched: x.unmatched, rules: x.rules })) } : null;
		});
		await page.close();
		return s;
	};
	const lab = await read('/dt-styles');
	const clean = await read('/dt-lab');
	if (!lab || !clean) return console.log('  ✗ styles: no __ogygia_styles on the page'), 0;
	const has = (s, code, text) => s.findings.some((f) => f.code === code && (!text || f.message.includes(text)));
	const unused = lab.sheets.find((x) => x.label === 'unused.css');
	const checks = [
		['unscoped named', has(lab, 'css-unscoped', 'LabCard.svelte') && lab.unscoped.length === 1],
		['the reason given', has(lab, 'css-unscoped', 'Unexpected token')],
		['unmatched named', has(lab, 'css-unmatched', 'unused.css')],
		['all 600 unmatched', unused?.unmatched === 600 && unused?.rules === 600],
		['decoy quiet', !lab.findings.some((f) => f.message.includes('Healthy'))],
		['clean page quiet', !has(clean, 'css-unscoped') && !has(clean, 'css-unmatched')]
	];
	const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
	console.log(`  ${bad.length ? '✗' : '✓'} styles: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}`);
	if (bad.length) console.log(`    lab: ${JSON.stringify(lab.findings)} · clean: ${JSON.stringify(clean.findings)}`);
	return bad.length ? 0 : 1;
}

/** THE RUNTIME'S OWN WAIT (/dt-many, 320 islands, scrolled): no island may sit waiting for its turn
 *  with nothing ahead of it. The `held-idle` finding is how the tools catch the scheduler holding
 *  islands for no reason — it named round 46's bug (200 islands, ~63 ms each) when that bug was put
 *  back. Silent here means the runtime hands out turns promptly. */
async function held_run(browser) {
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	await page.goto(base + '/dt-many', { waitUntil: 'load' });
	await page.waitForTimeout(2500);
	await page.mouse.wheel(0, 5000);
	await page.waitForTimeout(2000);
	const r = await page.evaluate(() => {
		const v = window.__ogygia_page?.();
		return v ? { held: v.report.findings.find((f) => f.code === 'held-idle')?.message ?? null, woke: v.report.rows.length } : null;
	});
	await page.close();
	const ok = !!r && !r.held && r.woke >= 300;
	console.log(`  ${ok ? '✓' : '✗'} runtime: ${r?.woke ?? 0} islands woke on /dt-many and none waited with nothing ahead${r?.held ? ` — ${r.held}` : ''}`);
	return ok ? 1 : 0;
}

/** AN IN-APP NAVIGATION: /dt-lab → /dt-styles keeps Healthy (the same island, the same props: the
 *  router reuses it, still awake) and the Page tab says so, rather than "nothing woke"; the styles
 *  follow the new page; /dt-styles → /dt-nest keeps nothing and its islands are wakes. */
async function nav_run(browser) {
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	await page.goto(base + '/dt-lab', { waitUntil: 'load' });
	await page.waitForTimeout(2500);
	const go = async (to) => {
		await page.evaluate((to) => {
			const a = document.createElement('a');
			a.href = to;
			a.id = 'og-key-go';
			a.textContent = 'go';
			document.body.prepend(a);
			a.click(); // the router takes a link's click (an in-app navigation, no reload)
		}, to);
		await page.waitForTimeout(2500);
		return page.evaluate(async () => {
			const v = window.__ogygia_page?.();
			const s = await window.__ogygia_styles?.();
			return { soft: !!window.__og_key_marker, nav: v?.nav?.to ?? null, rows: v?.report.rows.map((r) => r.name) ?? [], kept: (v?.kept ?? []).map((k) => k.name), css: s?.findings.map((f) => f.code) ?? [] };
		});
	};
	await page.evaluate(() => (window.__og_key_marker = 1));
	const a = await go('/dt-styles');
	const b = await go('/dt-nest');
	await page.close();
	const checks = [
		['a soft navigation', a.soft && b.soft && a.nav === '/dt-styles' && b.nav === '/dt-nest'],
		['Healthy kept, nothing woke', a.kept.join() === 'Healthy' && a.rows.length === 0],
		['styles follow the page', a.css.includes('css-unscoped') && !b.css.includes('css-unscoped')],
		['the next page: wakes, nothing kept', b.kept.length === 0 && b.rows.includes('NestOuter')]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} navigation: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ a, b })}` : ''}`);
	return bad.length ? 0 : 1;
}

/** HOLES WHOSE ANSWER NEVER CAME: /dt-holes plants a hole whose server render throws (500, every
 *  retry); the auth-wall cookie on /hole-wall makes a handle in front of ogygia's redirect the hole's
 *  request. Both must be named with their cause; the healthy holes (Greeting on /dt-holes, and on
 *  /hole-wall without the cookie) never. */
async function holes_run(browser) {
	const read = async (path, wall) => {
		const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
		if (wall) await ctx.addCookies([{ name: 'og-auth-wall', value: wall, url: base }]);
		const page = await ctx.newPage();
		await page.goto(base + path, { waitUntil: 'load' });
		// (the broken hole retries twice, 0.5 s then 1 s apart, before it gives up)
		await page.waitForTimeout(4500);
		const all = await page.evaluate(() => (window.__ogygia_page?.()?.report.findings ?? []).map((x) => ({ code: x.code, message: x.message })));
		await ctx.close();
		const f = all.filter((x) => x.code === 'hole-failed').map((x) => x.message);
		f.slow = all.filter((x) => x.code === 'hole-slow').map((x) => x.message);
		return f;
	};
	// the profiler's report of the same broken visit names the hole too (the beacon carries it)
	const rec = await fetch(`${base}/__profiler/page?p=/dt-holes&runs=1`, { redirect: 'manual' }).catch(() => null);
	const report_id = rec?.headers.get('location')?.split('/').pop() ?? null;
	const lab = await read('/dt-holes');
	const walled = await read('/hole-wall', 'redirect');
	const open = await read('/hole-wall');
	// five holes of 0.9 s: the server renders four at a time, the fifth waits for a slot (and the
	// profiler records this visit: its One clock draws a lane per hole)
	const qrec = await fetch(`${base}/__profiler/page?p=/dt-hole-queue&runs=1`, { redirect: 'manual' }).catch(() => null);
	const queue_report = qrec?.headers.get('location')?.split('/').pop() ?? null;
	const queue = await read('/dt-hole-queue');
	let clock_lanes = [];
	let clock_amber = 0;
	if (queue_report) {
		await new Promise((ok) => setTimeout(ok, 1500));
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		await page.goto(`${base}/__profiler/report/${queue_report}`, { waitUntil: 'load' });
		await page.waitForTimeout(1500);
		const sec = page.locator('section:has(h2:text("One clock"))');
		clock_lanes = await sec.locator('text').evaluateAll((t) => t.map((x) => x.textContent ?? '').filter((s) => s.startsWith('QueueHole')));
		clock_amber = await sec.locator('rect[fill="#f59e0b"]').count();
		await page.close();
	}
	// THE PAGE TAB'S HOLE WATERFALL: a bar per answer, split; a red row for the one that never came
	const waterfall = async (path) => {
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		await page.goto(base + path, { waitUntil: 'load' });
		await page.waitForTimeout(4500);
		if (!(await page.locator('[data-og-tab]').count())) await page.click('[data-og-panel-toggle]').catch(() => {});
		await page.waitForTimeout(800);
		await page.click('[data-og-tab="page"]').catch(() => {});
		await page.waitForTimeout(1200);
		const out = await page.locator('[data-og-page-holes] .row').evaluateAll((rows) =>
			rows.map((r) => ({ name: r.querySelector('.name')?.textContent ?? '', failed: r.hasAttribute('data-og-hole-failed'), segs: [...r.querySelectorAll('.seg')].map((s) => [...s.classList].find((c) => c.startsWith('h-'))) }))
		);
		// the holes' preload links fetch HTML: counted as fetch, never as CSS
		out.types = await page.evaluate(() => [...new Set((window.__ogygia_page?.()?.page.visit?.resources ?? []).filter((r) => r.url.includes('__ogygia__')).map((r) => r.type))]);
		await page.close();
		return out;
	};
	const wf_queue = await waterfall('/dt-hole-queue');
	const wf_lab = await waterfall('/dt-holes');
	// the profiler's dashboard, across the server: the queue seen, and QueueHole holding the slots
	const dash = await (await fetch(`${base}/__profiler`)).text().catch(() => '');
	const slots = dash.slice(dash.indexOf('data-hole-slots'), dash.indexOf('Slowest routes'));
	let in_report = null;
	let slow_in_report = null;
	if (report_id)
		for (let i = 0; i < 8 && !(in_report && slow_in_report); i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
			in_report = j?.findings?.find((f) => f.code === 'hole-failed')?.message ?? null;
			slow_in_report = j?.findings?.find((f) => f.code === 'hole-slow') ?? null;
		}
	const checks = [
		['the broken hole, 3 tries', lab.length === 1 && lab[0].includes('BrokenHole') && lab[0].includes('failed 3 times (status 500)')],
		['the healthy hole quiet', !lab.some((m) => m.includes('Greeting'))],
		['the refused hole, redirected', walled.length === 1 && walled[0].includes('Greeting') && walled[0].includes('redirected to /hole-wall/account')],
		['no wall, no finding', open.length === 0],
		// (SlowHole's server render waits 1.5 s: its fallback held the first screen that long)
		['the slow hole, named', lab.slow.length === 1 && lab.slow[0].includes('SlowHole')],
		['the slow hole, its server render', lab.slow.length === 1 && lab.slow[0].includes('the server render') && !lab.slow[0].includes('render slot')],
		[
			'the queued hole, its render slot',
			queue.slow.length === 1 && queue.slow[0].includes('waiting for a render slot on the server') && queue.slow[0].split('QueueHole (').length - 1 <= 2
		],
		[
			// (four slots: one waits; a cold server with a slot still busy can make it two)
			'the waterfall: five answers, the last waited for a slot',
			wf_queue.length === 5 && [1, 2].includes(wf_queue.filter((r) => r.segs.includes('h-slot')).length) && wf_queue.every((r) => r.segs.includes('h-render'))
		],
		['a hole preload counts as fetch, not CSS', wf_queue.types.length === 1 && wf_queue.types[0] === 'fetch'],
		['the waterfall: the broken hole in red', wf_lab.some((r) => r.failed && r.name === 'BrokenHole') && wf_lab.filter((r) => !r.failed).length === 2],
		['the report: a lane per hole, the slot wait in it', !queue_report || (clock_lanes.length === 5 && clock_lanes[4] === 'QueueHole 5' && clock_amber >= 1)],
		['the dashboard, who held the slots', slots.includes('waited for a render slot') && slots.includes('held mostly by QueueHole') && slots.includes('BrokenHole')],
		['the quick hole never slow', !lab.slow.some((m) => m.includes('Greeting')) && open.slow.length === 0],
		['the profiler report names it', !report_id || (in_report?.includes('BrokenHole') && in_report.includes('status 500'))],
		// the report joins the visit's hole requests from its log: the wait is the server render
		['the report splits the slow wait', !report_id || (!!slow_in_report?.message.includes('SlowHole') && slow_in_report.message.includes('the server render') && slow_in_report.fix.startsWith('The server render is the wait'))]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} holes: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ lab, slow: lab.slow, queue: queue.slow, clock_lanes, clock_amber, wf_queue, types: wf_queue.types, wf_lab, slots: slots.slice(0, 600), walled, open, in_report, slow_in_report })}` : ''}`);
	return bad.length ? 0 : 1;
}

/** AN ISLAND'S CODE (/dt-code, dev): Toolbar imports a barrel whole (its side effect keeps the
 *  barrel rewrite off it) and an icon set that is most of its weight. Both named on Toolbar; the
 *  Healthy decoy never; a page without them raises neither. */
/** AN ISLAND'S FILE GONE (/dt-cache, served as a page from a build whose files are deleted): Probe's
 *  region names a location that 404s. The island must wake through its stable name, and the Page tab
 *  and the profiler's report of the same visit must say this page outlived its build — naming Probe,
 *  never the islands whose files loaded. The page as served is quiet. */
async function fallback_run(browser) {
	// (asked as a browser asks for a page: the server adds the profiler's beacon tag only to a document)
	const live = await (await fetch(base + '/dt-cache', { headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } })).text();
	// Probe's open tag (the page's first island) gets a location that no longer exists (`src` goes
	// last, like the server's; the dev server's entries are virtual ids, so it is found by place)
	const stale = live.replace(/(<ogygia-region entry="[^"]+" wake="load"[^>]*?)>/, '$1 src="/__gone__/og-region.probe.Gone1234.js">');
	const read = async (html) => {
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		if (html) await page.route(base + '/dt-cache', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
		await page.goto(base + '/dt-cache', { waitUntil: 'load' });
		await page.waitForFunction(() => document.querySelector('[data-probe="probe"][data-ran]'), null, { timeout: 8000 }).catch(() => {});
		// (the report lands after the fresh import; the page view reads the beacon's visit on its tick)
		await page.waitForTimeout(2000);
		const out = await page.evaluate(() => ({
			probe_ran: document.querySelector('[data-probe="probe"]')?.getAttribute('data-ran') ?? null,
			findings: (window.__ogygia_page?.()?.report.findings ?? []).filter((x) => x.code === 'island-file-gone').map((x) => ({ message: x.message, severity: x.severity }))
		}));
		await page.close();
		return out;
	};
	const rec = await fetch(`${base}/__profiler/page?p=/dt-cache&runs=1`, { redirect: 'manual' }).catch(() => null);
	const report_id = rec?.headers.get('location')?.split('/').pop() ?? null;
	const planted = await read(stale);
	const clean = await read(null);
	let in_report = null;
	if (report_id)
		for (let i = 0; i < 8 && !in_report; i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
			in_report = j?.findings?.find((f) => f.code === 'island-file-gone')?.message ?? null;
		}
	const f = planted.findings[0];
	const checks = [
		['the island still woke (through its stable name)', planted.probe_ran === 'v1'],
		['named: Probe, woke on the current build', !!f && f.message.includes('Probe') && f.message.includes('woke on the current build') && f.severity === 'warn'],
		['the islands whose files loaded, never', !!f && !f.message.includes('Twin') && !f.message.includes('Steady')],
		['the page as served is quiet', clean.findings.length === 0],
		['the profiler report names it', !report_id || (in_report?.includes('Probe') ?? false)]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} file gone: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ planted, clean, in_report })}` : ''}`);
	return bad.length ? 0 : 1;
}

/** PRELOADS DOWNLOADED AGAIN (/dt-preload): a fetch preload without `crossorigin` (the plant) goes
 *  unused and the file comes down twice; the decoy's matches and is used. Named in the Page tab and
 *  in the profiler's report of the same visit; the decoy never; a page without preloads quiet. */
async function preload_run(browser) {
	const read = async (path) => {
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		await page.goto(base + path, { waitUntil: 'load' });
		await page.waitForTimeout(2500);
		const f = await page.evaluate(() => (window.__ogygia_page?.()?.report.findings ?? []).filter((x) => x.code === 'preload-unused').map((x) => ({ message: x.message, fix: x.fix })));
		await page.close();
		return f;
	};
	const rec = await fetch(`${base}/__profiler/page?p=/dt-preload&runs=1`, { redirect: 'manual' }).catch(() => null);
	const report_id = rec?.headers.get('location')?.split('/').pop() ?? null;
	const lab = await read('/dt-preload');
	const clean = await read('/dt-lab');
	let in_report = null;
	if (report_id)
		for (let i = 0; i < 8 && !in_report; i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
			in_report = j?.findings?.find((f) => f.code === 'preload-unused')?.message ?? null;
		}
	const checks = [
		['the planted preload, named with its bytes', lab.length === 1 && lab[0].message.startsWith('planted (') && lab[0].message.includes('twice')],
		['the fix names crossorigin', lab[0]?.fix.includes('A fetch preload needs `crossorigin`') ?? false],
		['the decoy never', !lab.some((f) => f.message.includes('decoy'))],
		['a page without preloads quiet', clean.length === 0],
		['the profiler report names it', !report_id || (in_report?.includes('In the browser: planted (') ?? false)]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} preloads: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ lab, clean, in_report })}` : ''}`);
	return bad.length ? 0 : 1;
}

/** THE SLOWEST INTERACTION (/dt-inp): SlowSave's click runs 260 ms in its own handler; a click on
 *  QuickCount just after BusyTimer's waits behind BusyTimer's 400 ms timer; QuickCount alone is
 *  quick. The INP finding must name the island clicked, the phase that cost the time, and (for the
 *  wait) the timer — in the Page tab and in the profiler's report of the same visit. (Raw mouse
 *  clicks: Playwright's click waits for the page to be idle, so a queued click would never queue.) */
async function inp_run(browser) {
	const read = async (mode) => {
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		await page.goto(base + '/dt-inp', { waitUntil: 'load' });
		await page.waitForTimeout(1800);
		const box = async (sel) => {
			const b = await page.locator(sel).boundingBox();
			return b ? [b.x + b.width / 2, b.y + b.height / 2] : [0, 0];
		};
		if (mode === 'save') await page.mouse.click(...(await box('[data-inp="save"]')));
		if (mode === 'busy') {
			const count = await box('[data-inp="count"]');
			await page.mouse.click(...(await box('[data-inp="busy"]')));
			await page.waitForTimeout(80);
			await page.mouse.click(...count);
		}
		if (mode === 'count') await page.mouse.click(...(await box('[data-inp="count"]')));
		// (the browser reports an interaction's timing after its next paint: give it a moment)
		await page.waitForTimeout(1000);
		const out = await page.evaluate(() => {
			const r = window.__ogygia_page?.()?.report;
			const f = r?.findings.find((x) => x.code === 'slow-interaction' || x.code === 'vital-inp');
			return { inp: r?.vitals.find((v) => v.key === 'inp')?.value ?? null, message: f?.message ?? null, fix: f?.fix ?? null, fps: f?.fps ?? [] };
		});
		// leave the page the way a visitor does: the beacon sends its final visit on the hide (a fixed
		// wait raced its timed resend on a loaded machine, and the report kept the visit before the click)
		await page.goto('about:blank');
		await page.waitForTimeout(300);
		await page.close();
		return out;
	};
	const rec = await fetch(`${base}/__profiler/page?p=/dt-inp&runs=1`, { redirect: 'manual' }).catch(() => null);
	const report_id = rec?.headers.get('location')?.split('/').pop() ?? null;
	const save = await read('save');
	const busy = await read('busy');
	const count = await read('count');
	let in_report = null;
	if (report_id)
		for (let i = 0; i < 8 && !in_report; i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
			in_report = j?.findings?.find((f) => f.code === 'slow-interaction')?.message ?? null;
		}
	// the phases, read back out of the message: they must add up to the INP (within a frame's rounding)
	const phase_ms = (m) => {
		const n = (label) => {
			const at = m?.indexOf(label) ?? -1;
			if (at < 0) return NaN;
			const head = m.slice(0, at).trimEnd();
			return Number(head.slice(head.lastIndexOf(' ') + 1));
		};
		return [n(' ms before its handlers'), n(' ms in its handlers'), n(' ms to paint')];
	};
	const sums = (r) => {
		const p = phase_ms(r.message);
		return p.every(Number.isFinite) && Math.abs(p[0] + p[1] + p[2] - r.inp) <= 3;
	};
	const checks = [
		['slow handler: named on SlowSave, the Save button, in its own handler', !!save.message && save.message.includes('a click on button "Save" in SlowSave') && save.message.includes("(mostly SlowSave's own click handler)") && save.fix?.startsWith('The handler itself is the cost') && save.fps.length === 1],
		['slow handler: its phases add up to the INP', sums(save)],
		['queued click: on QuickCount, waited, behind BusyTimer’s timer', !!busy.message && busy.message.includes('in QuickCount') && busy.message.includes('before its handlers could run (the main thread was running') && busy.message.includes('planted_busy_timer (a timer') && busy.fix?.startsWith('The input waited for other work')],
		['queued click: its phases add up to the INP', sums(busy)],
		['the quick click alone: no INP finding', count.message === null && (count.inp ?? 0) < 200],
		['the profiler report explains the same click', !report_id || (in_report?.includes("SlowSave's own click handler") ?? false)]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} interactions: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ save, busy, count, in_report })}` : ''}`);
	return bad.length ? 0 : 1;
}

/** THE SLOWEST INTERACTION, SAMPLED (/dt-inp): the frames name only Svelte's event dispatcher, so the
 *  handler's own function comes from a CPU trace — the load trace for a click during the load, the
 *  interaction sampler (started once the load trace is out) for a click after it. Both must name
 *  SlowSave's `save`, in the Page tab and in the profiler's report of the same visit; the queued
 *  click must name BusyTimer's timer function. */
async function inp_cpu_run(browser) {
	const read = async (mode, late) => {
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		await page.goto(base + '/dt-inp', { waitUntil: 'load' });
		await page.waitForTimeout(1800);
		const done = () => page.waitForFunction(() => window.__ogygia_page?.()?.page.cpu.state === 'done', null, { timeout: 30_000 }).catch(() => {});
		// late: past the load trace (the interaction sampler is running then)
		if (late) {
			await done();
			await page.waitForTimeout(500);
		}
		const at = async (sel) => {
			const b = await page.locator(sel).boundingBox();
			return [b.x + b.width / 2, b.y + b.height / 2];
		};
		if (mode === 'save') await page.mouse.click(...(await at('[data-inp="save"]')));
		else {
			const count = await at('[data-inp="count"]');
			await page.mouse.click(...(await at('[data-inp="busy"]')));
			await page.waitForTimeout(80);
			await page.mouse.click(...count);
		}
		// early: the load trace, which holds the click, ends later
		if (!late) await done();
		await page.waitForTimeout(1200);
		const m = await page.evaluate(() => window.__ogygia_page?.()?.report.findings.find((f) => f.code === 'slow-interaction')?.message ?? null);
		await page.goto('about:blank');
		await page.waitForTimeout(300);
		await page.close();
		return m;
	};
	const in_report = async (id, needle) => {
		for (let i = 0; i < 10 && id; i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${id}.json`)).json().catch(() => null);
			const m = j?.findings?.find((f) => f.code === 'slow-interaction')?.message ?? null;
			if (m?.includes(needle)) return m;
		}
		return null;
	};
	const record = async () => (await fetch(`${base}/__profiler/page?p=/dt-inp&runs=1`, { redirect: 'manual' }).catch(() => null))?.headers.get('location')?.split('/').pop() ?? null;
	const late_id = await record();
	const late = await read('save', true);
	const late_report = await in_report(late_id, "SlowSave's save (SlowSave.svelte");
	const early_id = await record();
	const early = await read('save', false);
	const early_report = await in_report(early_id, "SlowSave's save (SlowSave.svelte");
	const busy = await read('busy', true);
	// (the dev server's browser frames carry the served code's lines, not the source's: the function
	// and its file are quoted, never a wrong line)
	const sampled = (m) => !!m && m.includes("(mostly SlowSave's save (SlowSave.svelte), ") && m.includes('ms sampled)');
	const checks = [
		['late click (the interaction sampler): the Page tab names save', sampled(late)],
		// (the line: the dev server's browser frames are not source-mapped yet, in either tool)
		['late click: the profiler report names save', !late_id || sampled(late_report)],
		['early click (the load trace): the Page tab names save', sampled(early)],
		['early click: the profiler report names save', !early_id || sampled(early_report)],
		['queued click: the wait names the timer’s function, run by a timer', !!busy && busy.includes('the main thread was running planted_busy_timer (BusyTimer.svelte), ') && busy.includes('run by a timer')]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} interactions sampled: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ late, late_report, early, early_report, busy })}` : ''}`);
	return bad.length ? 0 : 1;
}

async function code_run(browser) {
	const read = async (path) => {
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		await page.goto(base + path, { waitUntil: 'load' });
		// the dev sizes arrive with the dock's mount: open it
		await page.waitForTimeout(1500);
		if (!(await page.locator('[data-og-tab]').count())) await page.click('[data-og-panel-toggle]').catch(() => {});
		await page.waitForTimeout(1500);
		const f = await page.evaluate(() => (window.__ogygia_page?.()?.report.findings ?? []).filter((x) => x.code.startsWith('island-')).map((x) => ({ code: x.code, message: x.message })));
		await page.close();
		return f;
	};
	const lab = await read('/dt-code');
	const clean = await read('/dt-lab');
	const has = (code, text) => lab.some((f) => f.code === code && f.message.includes(text));
	const checks = [
		['the barrel, on Toolbar', has('island-barrel', 'Toolbar still imports a barrel whole: src/lib/dtcode/index.ts')],
		['the heavy module, on Toolbar', has('island-heavy-module', "Icons.svelte is") && has('island-heavy-module', "of Toolbar's code")],
		['the decoy quiet', !lab.some((f) => f.message.includes('Healthy'))],
		['a clean page quiet', clean.length === 0]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} island code: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ lab, clean })}` : ''}`);
	return bad.length ? 0 : 1;
}

/** A KIT-HYDRATED PAGE (/score-lab-kit, csr=true): the ogygia runtime never boots there, yet the
 *  dock shows what the browser saw — the csr=true note, the vitals, the files, the styles — and
 *  no island tools. */
async function csr_true_run(browser) {
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	await page.goto(base + '/score-lab-kit', { waitUntil: 'load' });
	await page.waitForTimeout(2500);
	if (!(await page.locator('[data-og-csr-notice]').count())) await page.click('[data-og-panel-toggle]').catch(() => {});
	await page.waitForTimeout(1500);
	const r = await page.evaluate(() => {
		const v = window.__ogygia_page?.();
		return v ? { vitals: v.report.vitals.map((x) => x.key), files: v.report.bytes.length, rows: v.report.rows.length } : null;
	});
	const ui = { notice: await page.locator('[data-og-csr-notice]').count(), vitals: await page.locator('[data-og-vitals] .vital').count(), styles: await page.locator('[data-og-page-styles]').count(), tabs: await page.locator('[data-og-tab]').count() };
	await page.close();
	const checks = [
		['the csr=true note', ui.notice === 1 && ui.tabs === 0],
		['vitals', !!r && r.vitals.includes('lcp') && ui.vitals >= 3],
		['files and styles', !!r && r.files > 0 && ui.styles === 1],
		['no island rows', !!r && r.rows === 0]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} csr=true page: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ r, ui })}` : ''}`);
	return bad.length ? 0 : 1;
}

function grade(view) {
	const name_of = new Map(view.regions.map((r) => [r.fp, r.name]));
	const found = {};
	const decoy_hits = [];
	const extra = [];
	for (const f of view.findings) {
		const names = f.fps.map((fp) => name_of.get(fp) ?? fp);
		if (!VICTIM.has(f.code)) for (const n of names) if (DECOYS.includes(n)) decoy_hits.push(`${f.code} names decoy ${n}`);
		if (f.code in PLANTED) {
			const want = PLANTED[f.code];
			if (want === null || names.includes(want)) found[f.code] = true;
		}
		for (const n of names) {
			const planted_for = Object.entries(PLANTED).filter(([, v]) => v === n).map(([k]) => k);
			if (planted_for.length && !planted_for.includes(f.code) && !f.code.startsWith('vital-')) extra.push(`${f.code} also names ${n}`);
		}
	}
	return { found, decoy_hits, extra };
}

const server = serve ? await start_server() : null;
const browser = await chromium.launch();
let failed = false;
let cpu_fail = 0;
let hyd_fail = 0;
try {
	const tally = Object.fromEntries(Object.keys(PLANTED).map((k) => [k, 0]));
	var tally_report = {};
	var report_runs = 0;
	var report_cpu_ok = 0;
	var report_held_ok = 0;
	for (let i = 0; i < repeat; i++) {
		const view = await one_run(browser);
		const g = grade(view);
		for (const k of Object.keys(g.found)) tally[k]++;
		const codes = view.findings.map((f) => f.code).join(', ');
		console.log(`run ${i + 1}: ${codes || 'no findings'}`);
		// hydration: the planted statuses, the decoys clean
		// (Edited: a page script rewrote it before the runtime first saw it — its remembered copy already
		// carries the edit, so the browser sees a markup change; `healed` when the runtime saw it first)
		const WANT = { Broken: ['failed'], Clock: ['changed'], Edited: ['healed', 'changed'], Healthy: ['clean'] };
		const bad = Object.entries(WANT).filter(([n, s]) => !s.includes(view.hydration[n]));
		if (bad.length) {
			hyd_fail++;
			console.log(`  ✗ hydration tab: ${bad.map(([n, s]) => `${n} ${view.hydration[n] ?? 'missing'} (want ${s.join('|')})`).join(', ')}`);
		} else console.log(`  ✓ hydration tab: Broken failed · Clock changed · Edited ${view.hydration.Edited} · Healthy clean`);
		// THE PROFILER REPORT of the same visit: the same planted problems, on the same islands
		if (view.report) {
			const r = grade({ ...view, findings: view.report.browser_findings });
			for (const k of Object.keys(r.found)) tally_report[k] = (tally_report[k] ?? 0) + 1;
			report_runs++;
			const missed = Object.keys(PLANTED).filter((k) => !r.found[k]);
			console.log(`  ${missed.length ? '·' : '✓'} profiler report: ${view.report.browser_findings.map((f) => f.code).join(', ') || 'no browser findings'}${missed.length ? ` (missed ${missed.join(', ')})` : ''}`);
			for (const d of r.decoy_hits) {
				console.log(`  ✗ profiler report: ${d}`);
				failed = true;
			}
			// and the browser's CPU, cut by island on the server, names what ran
			const heavy = view.report.browser_findings.find((f) => f.code === 'long-hydrate')?.message ?? '';
			const outside = view.report.browser_findings.find((f) => f.code === 'long-tasks')?.message ?? '';
			const ok = heavy.includes('Heavy.svelte') && outside.includes('mostly');
			if (ok) report_cpu_ok++;
			// the slowest wake is a queue, and the island that held it is the planted long hydrate
			const held = view.report.client?.message?.includes('behind Heavy') && view.report.client?.fix?.includes('Heavy held the queue');
			if (held) report_held_ok++;
			console.log(`  ${held ? '✓' : '·'} profiler report: the slowest wake waited behind Heavy${held ? '' : ` — ${view.report.client?.message?.slice(0, 160) ?? 'no client-hydrate'}`}`);
			console.log(`  ${ok ? '✓' : '·'} profiler report CPU: ${heavy.includes('Heavy.svelte') ? '✓' : '✗'} long hydrate names Heavy.svelte · ${outside.includes('mostly') ? '✓' : '✗'} page script named${ok ? '' : ` — ${heavy.slice(0, 140)} | ${outside.slice(0, 140)}`}`);
		}
		// (the counted list is taken a moment before the browser's: a file may land in between)
		if (view.files.counted < view.files.browser - 3) {
			console.log(`  ✗ files: the Page tab counts ${view.files.counted}, the browser loaded ${view.files.browser}`);
			failed = true;
		} else console.log(`  ✓ files: ${view.files.counted} counted of ${view.files.browser}`);
		const missing_ui = view.findings.filter((f) => !view.shown.includes(f.code)).map((f) => f.code);
		if (missing_ui.length) {
			console.log(`  ✗ the Page tab does not show: ${missing_ui.join(', ')} (shown: ${view.shown.join(', ') || 'nothing'})`);
			failed = true;
		}
		for (const d of g.decoy_hits) {
			console.log(`  ✗ ${d}`);
			failed = true;
		}
		for (const e of g.extra) console.log(`  · ${e}`);
		for (const k of Object.keys(PLANTED)) if (!g.found[k] && process.env.DT_KEY_DEBUG) console.log(`  ? missed ${k}: shifts ${JSON.stringify(view.shifts)} rows ${JSON.stringify(view.rows.map((r) => [r.name, r.t0, r.done, r.shift]))}`);
		for (const f of view.findings) if (!(f.code in PLANTED)) console.log(`  · unplanted ${f.code}: ${f.message.slice(0, 160)}`);
		// THE MAIN THREAD: the browser's own sampler names the code behind each long task
		if (!view.cpu) {
			console.log(`  ✗ no CPU trace (${view.cpu_off ?? 'none'})`);
			cpu_fail++;
		} else {
			const heavy = view.findings.find((f) => f.code === 'long-hydrate')?.message ?? '';
			const outside = view.findings.find((f) => f.code === 'long-tasks')?.message ?? '';
			const ok_heavy = heavy.includes('Heavy.svelte');
			const ok_outside = outside.includes('mostly');
			if (!ok_heavy || !ok_outside) cpu_fail++;
			console.log(`  ${ok_heavy ? '✓' : '✗'} CPU: the long hydrate names Heavy.svelte · ${ok_outside ? '✓' : '✗'} the page script's long task is named — ${view.cpu.busy} ms busy (${view.cpu.kinds.map((k) => `${k.kind} ${Math.round(k.ms)}`).join(', ')})`);
		}
	}
	const need = repeat >= 3 ? 2 : repeat;
	// third parties: both the Page tab and the profiler report, graded per run
	let third_ok = 0;
	for (let i = 0; i < repeat; i++) third_ok += await third_run(browser);
	if (third_ok < need * 2) failed = true;
	console.log(`${third_ok >= need * 2 ? '✓' : '✗'} third parties: ${third_ok}/${repeat * 2} (Page tab + profiler report per run)`);
	// styles: deterministic (no timing in it), so every run must hold
	let styles_ok = 0;
	for (let i = 0; i < repeat; i++) styles_ok += await styles_run(browser);
	if (styles_ok < repeat) failed = true;
	console.log(`${styles_ok === repeat ? '✓' : '✗'} styles: ${styles_ok}/${repeat}`);
	// the runtime's scheduler: deterministic enough to hold in every run
	let held_ok = 0;
	for (let i = 0; i < repeat; i++) held_ok += await held_run(browser);
	if (held_ok < repeat) failed = true;
	console.log(`${held_ok === repeat ? '✓' : '✗'} runtime hands out turns promptly: ${held_ok}/${repeat}`);
	let nav_ok = 0;
	for (let i = 0; i < repeat; i++) nav_ok += await nav_run(browser);
	if (nav_ok < repeat) failed = true;
	console.log(`${nav_ok === repeat ? '✓' : '✗'} navigation (kept islands, styles, wakes): ${nav_ok}/${repeat}`);
	let holes_ok = 0;
	for (let i = 0; i < repeat; i++) holes_ok += await holes_run(browser);
	if (holes_ok < repeat) failed = true;
	console.log(`${holes_ok === repeat ? '✓' : '✗'} holes whose answer never came: ${holes_ok}/${repeat}`);
	let fallback_ok = 0;
	for (let i = 0; i < repeat; i++) fallback_ok += await fallback_run(browser);
	if (fallback_ok < repeat) failed = true;
	console.log(`${fallback_ok === repeat ? '✓' : '✗'} an island's file gone: ${fallback_ok}/${repeat}`);
	let preload_ok = 0;
	for (let i = 0; i < repeat; i++) preload_ok += await preload_run(browser);
	if (preload_ok < repeat) failed = true;
	console.log(`${preload_ok === repeat ? '✓' : '✗'} preloads downloaded again: ${preload_ok}/${repeat}`);
	let inp_ok = 0;
	for (let i = 0; i < repeat; i++) inp_ok += await inp_run(browser);
	if (inp_ok < repeat) failed = true;
	console.log(`${inp_ok === repeat ? '✓' : '✗'} the slowest interaction explained: ${inp_ok}/${repeat}`);
	let icpu_ok = 0;
	for (let i = 0; i < repeat; i++) icpu_ok += await inp_cpu_run(browser);
	if (icpu_ok < repeat) failed = true;
	console.log(`${icpu_ok === repeat ? '✓' : '✗'} the slowest interaction sampled (its function named): ${icpu_ok}/${repeat}`);
	let code_ok = 0;
	for (let i = 0; i < repeat; i++) code_ok += await code_run(browser);
	if (code_ok < repeat) failed = true;
	console.log(`${code_ok === repeat ? '✓' : '✗'} island code (barrel, heavy module): ${code_ok}/${repeat}`);
	let csr_ok = 0;
	for (let i = 0; i < repeat; i++) csr_ok += await csr_true_run(browser);
	if (csr_ok < repeat) failed = true;
	console.log(`${csr_ok === repeat ? '✓' : '✗'} a Kit-hydrated page shows what the browser saw: ${csr_ok}/${repeat}`);
	if (repeat - cpu_fail < need) {
		failed = true;
		console.log(`✗ CPU naming held in ${repeat - cpu_fail}/${repeat} runs`);
	} else console.log(`✓ CPU naming: ${repeat - cpu_fail}/${repeat}`);
	if (repeat - hyd_fail < need) {
		failed = true;
		console.log(`✗ hydration statuses held in ${repeat - hyd_fail}/${repeat} runs`);
	} else console.log(`✓ hydration statuses: ${repeat - hyd_fail}/${repeat}`);
	if (report_runs) {
		const rneed = report_runs >= 3 ? 2 : report_runs;
		if (report_cpu_ok < rneed) failed = true;
		console.log(`${report_cpu_ok >= rneed ? '✓' : '✗'} profiler report CPU naming: ${report_cpu_ok}/${report_runs}`);
		if (report_held_ok < rneed) failed = true;
		console.log(`${report_held_ok >= rneed ? '✓' : '✗'} profiler report names the island that held the queue (Heavy): ${report_held_ok}/${report_runs}`);
		for (const code of Object.keys(PLANTED)) {
			const n = tally_report[code] ?? 0;
			if (n < rneed) failed = true;
			console.log(`${n >= rneed ? '✓' : '✗'} profiler report ${code}${PLANTED[code] ? ` on ${PLANTED[code]}` : ''}: ${n}/${report_runs}`);
		}
	} else console.log('· no profiler report (the profiler is off on this server)');
	for (const [code, n] of Object.entries(tally)) {
		const ok = n >= need;
		if (!ok) failed = true;
		console.log(`${ok ? '✓' : '✗'} ${code}${PLANTED[code] ? ` on ${PLANTED[code]}` : ''}: ${n}/${repeat}`);
	}
} finally {
	await browser.close();
	server?.kill();
}
console.log(failed ? 'FAILED' : 'all planted found, no decoy named');
process.exit(failed ? 1 : 0);
