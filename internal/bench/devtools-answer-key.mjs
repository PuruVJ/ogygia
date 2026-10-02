// THE DEVTOOLS PAGE TAB'S ANSWER KEY: load the playground's /dt-lab (every PLANTED island has one
// problem the browser can measure, every DECOY is healthy), act like a hurried visitor, and check
// the Page tab's report (`window.__ogygia_page()`, the same object the tab renders): each planted
// problem found and pinned on its island, no decoy named by anything.
//
// Against a dev server you started (devtools is dev-only):
//   cd apps/playground && OGYGIA_DEVTOOLS=1 OGYGIA_RESTORE_LAB=1 node node_modules/vite/bin/vite.js dev --port 4183 --host 127.0.0.1
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
		// (the restore lab's transform too: /restore-lab and /dt-restore need it)
		env: { ...process.env, OGYGIA_DEVTOOLS: '1', OGYGIA_RESTORE_LAB: '1', ORIGIN: base },
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
	// leave the way a visitor does: the page hides and the final visit goes out (a bare close may not
	// fire the hide; the report then keeps the early visit)
	await page.goto('about:blank');
	await page.waitForTimeout(300);
	await page.close();
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
	// leave the way a visitor does: the page hides and the beacon sends its final visit (a bare close
	// may not fire the hide, and the report kept the early visit, before the edited island's rows)
	await page.goto('about:blank');
	await page.waitForTimeout(300);
	await page.close();
	let report = null;
	// (until every finding the plant makes is in: the island rows land after the scripts' timings)
	const complete = (r) => !!r && ['third-party', 'third-party-blocking', 'third-party-edits'].every((c) => r.some((f) => f.code === c));
	if (report_id)
		for (let i = 0; i < 12 && !complete(report); i++) {
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

/** A SLOW IN-APP NAVIGATION (/dt-nav-fast → /dt-nav-slow, whose load waits 800 ms; back is the
 *  decoy, fast): named with its split (the server's fetch the most of it) in the Page tab after the
 *  navigation and in the profiler's report of the same document; the navigation back never. */
async function nav_slow_run(browser) {
	const rec = await fetch(`${base}/__profiler/page?p=/dt-nav-fast&runs=1`, { redirect: 'manual' }).catch(() => null);
	const report_id = rec?.headers.get('location')?.split('/').pop() ?? null;
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	await page.goto(base + '/dt-nav-fast', { waitUntil: 'load' });
	await page.waitForTimeout(1500);
	await page.evaluate(() => (window.__og_key_soft = 1));
	await page.click('[data-nav-go="slow"]');
	await page.waitForSelector('[data-nav-page="slow"]', { timeout: 10_000 }).catch(() => {});
	await page.waitForTimeout(1500);
	const slow = await page.evaluate(() => ({ soft: window.__og_key_soft === 1, m: window.__ogygia_page?.()?.report.findings.find((f) => f.code === 'slow-navigation')?.message ?? null }));
	await page.click('[data-nav-go="fast"]');
	await page.waitForSelector('[data-nav-page="fast"]', { timeout: 10_000 }).catch(() => {});
	await page.waitForTimeout(1500);
	const back = await page.evaluate(() => (window.__ogygia_page?.()?.report.findings ?? []).filter((f) => f.code === 'slow-navigation').map((f) => f.message));
	// the same slow page, its link hovered first (the router prefetches it): named as prefetched,
	// with how much earlier its request began
	// (a short hover: the page's 800 ms answer is still most of the way off at the click, so the
	// navigation stays past the 400 ms a slow one starts at)
	await page.hover('[data-nav-go="slow-hover"]');
	await page.waitForTimeout(150);
	await page.click('[data-nav-go="slow-hover"]');
	await page.waitForSelector('[data-nav-page="slow"]', { timeout: 10_000 }).catch(() => {});
	await page.waitForTimeout(1500);
	const hovered = await page.evaluate(() => window.__ogygia_page?.()?.report.findings.find((f) => f.code === 'slow-navigation')?.message ?? null);
	await page.goto('about:blank');
	await page.waitForTimeout(300);
	await page.close();
	let report = null;
	for (let i = 0; i < 10 && report_id && !report?.length; i++) {
		await new Promise((ok) => setTimeout(ok, 1000));
		const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
		report = (j?.findings ?? []).filter((f) => f.code === 'slow-navigation').map((f) => f.message);
	}
	// the fetch is the most of it: its ms are the largest of the three quoted
	const fetch_most = (m) => {
		const n = (label) => {
			const at = m?.indexOf(label) ?? -1;
			if (at < 0) return NaN;
			const head = m.slice(0, at).trimEnd();
			return Number(head.slice(head.lastIndexOf(' ') + 1));
		};
		const f = n(' ms fetching the page');
		return f >= 700 && f > n(' ms loading its stylesheets') && f > n(' ms swapping it in');
	};
	const checks = [
		['a soft navigation', slow.soft],
		['the Page tab names it, the server’s fetch the most of it, and the island after', !!slow.m && slow.m.startsWith('The in-app navigation to /dt-nav-slow took') && fetch_most(slow.m) && slow.m.includes('Then its island woke')],
		['the fetch split: the server’s first byte, the download', !!slow.m && slow.m.includes('ms waiting for its first byte,') && slow.m.includes('ms downloading')],
		['the fast one back: never', back.length === 0],
		['hovered first: prefetched, the head start said', !!hovered && hovered.includes('still waiting for the page after the click (prefetched on hover') && hovered.includes('ms earlier: the server took')],
		// (the report lists the visit's slowest: the plain click first, then the hovered one)
		['the profiler report: the slow ones, never the fast', !report_id || (!!report && report.length >= 1 && report.every((m) => m.includes('In the browser: The in-app navigation to /dt-nav-slow')) && fetch_most(report[0]))],
		// the report joins the page request's server side (the request log): the plant's load waits on a
		// timer — no outbound call, little code — so most of it is "something else"
		['the report: the server side of the fetch, the wait on a timer', !report_id || (!!report && /On the server that page took \d+ ms: \d+ ms running code, no outbound calls, and \d+ ms waiting on something else/.test(report[0] ?? ''))]
	];
	// A VISIT THAT NEVER COMES BACK: land, navigate away, leave from there. The visit is the landing
	// page's (the document's story): its report must hold the navigation — the beacon once filed the
	// rest of the visit under the page the address bar showed when it sent, where it was never read
	{
		const rec2 = await fetch(`${base}/__profiler/page?p=/dt-nav-fast&runs=1`, { redirect: 'manual' }).catch(() => null);
		const id2 = rec2?.headers.get('location')?.split('/').pop() ?? null;
		const p2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		await p2.goto(base + '/dt-nav-fast', { waitUntil: 'load' });
		await p2.waitForTimeout(1500);
		await p2.click('[data-nav-go="slow"]');
		await p2.waitForSelector('[data-nav-page="slow"]', { timeout: 10_000 }).catch(() => {});
		await p2.waitForTimeout(1500);
		await p2.goto('about:blank');
		await p2.waitForTimeout(300);
		await p2.close();
		let away = null;
		for (let i = 0; i < 10 && id2 && !away; i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${id2}.json`)).json().catch(() => null);
			away = (j?.findings ?? []).find((f) => f.code === 'slow-navigation')?.message ?? null;
		}
		checks.push(['navigated away for good: the landing page’s report still holds it', !id2 || (away?.includes('to /dt-nav-slow') ?? false)]);
	}
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} slow navigation: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ slow, back, hovered, report })}` : ''}`);
	return bad.length ? 0 : 1;
}

/** THE LARGEST PAINT, EXPLAINED (/dt-lcp): the hero image in the server HTML, answered in 2.6 s — the
 *  download is the cost; `?late`: the island adds a quick image 2.6 s after it wakes — the late find
 *  is the cost. Both named on the Hero island with the fix for their part, in the Page tab and in
 *  the profiler's report of the same visit. */
async function lcp_run(browser) {
	const read = async (q) => {
		const rec = await fetch(`${base}/__profiler/page?p=${encodeURIComponent('/dt-lcp')}&runs=1`, { redirect: 'manual' }).catch(() => null);
		const report_id = rec?.headers.get('location')?.split('/').pop() ?? null;
		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
		await page.goto(base + '/dt-lcp' + q, { waitUntil: 'load' });
		await page.waitForTimeout(6500);
		const tab = await page.evaluate(() => {
			const f = window.__ogygia_page?.()?.report.findings.find((x) => x.code === 'slow-lcp');
			return f ? { message: f.message, fix: f.fix, fps: f.fps } : null;
		});
		await page.goto('about:blank');
		await page.waitForTimeout(300);
		await page.close();
		let report = null;
		for (let i = 0; i < 10 && report_id && !report; i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
			const f = (j?.findings ?? []).find((x) => x.code === 'slow-lcp');
			report = f ? { message: f.message, fix: f.fix } : null;
			// (an island named by its file: the report kept no island rows — say what its recorded
			// requests held, the open "islands 1, rows 0" case)
			if (report && !report.message.includes(') in Hero:'))
				report.why = {
					islands: j?.ogygia?.islands ?? null,
					rows: Array.isArray(j?.ogygia?.island_rows) ? j.ogygia.island_rows.length : null,
					requests: (j?.requests ?? []).map((r) => `${r.method} ${r.path} ${r.status} ${r.internal ? 'own' : 'other'} ${r.ms}ms inflight=${r.inflight}`)
				};
		}
		return { tab, report, report_id };
	};
	const plain = await read('');
	const late = await read('?late');
	// SINCE YOUR LAST PROFILE, THE VITALS: a profile of /dt-lcp with the slow hero, then one with the
	// quick twin — the second report's comparison must say LCP fell, and that its download is the
	// part that shrank
	let since = null;
	{
		const visit_after = async (q) => {
			const r = await fetch(`${base}/__profiler/page?p=${encodeURIComponent('/dt-lcp')}&runs=1`, { redirect: 'manual' }).catch(() => null);
			const id = r?.headers.get('location')?.split('/').pop() ?? null;
			const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
			await page.goto(base + '/dt-lcp' + q, { waitUntil: 'load' });
			await page.waitForTimeout(4000);
			await page.goto('about:blank');
			await page.waitForTimeout(300);
			await page.close();
			return id;
		};
		await visit_after('');
		const id = await visit_after('?quick');
		for (let i = 0; i < 10 && id && !since; i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const k = await (await fetch(`${base}/__profiler/report/${id}.json`)).json().catch(() => null);
			since = k?.since?.vitals ?? null;
		}
	}
	// SINCE YOUR LAST LOAD, THE PART (the Page tab, the dev loop): the slow hero, then the quick twin
	// in the SAME tab (the picture rides in session storage, per tab) — LCP fell, mostly its download
	let reload = null;
	{
		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
		await page.goto(base + '/dt-lcp', { waitUntil: 'load' });
		await page.waitForTimeout(4000);
		await page.goto(base + '/dt-lcp?quick', { waitUntil: 'load' });
		for (let i = 0; i < 10 && !reload?.some((m) => m.what === 'LCP'); i++) {
			await page.waitForTimeout(500);
			reload = await page.evaluate(() => window.__ogygia_page?.()?.since?.moved ?? null);
		}
		await page.close();
	}
	const on_hero = (f) => !!f && f.message.includes('The largest paint was the img (hero.svg') && f.message.includes(') in Hero:');
	const checks = [
		['in the HTML: named on Hero, the download the cost', on_hero(plain.tab) && plain.tab.fix.startsWith('The file itself is slow to download') && plain.tab.fps.length === 1],
		['added late: named on Hero, the late find the cost', on_hero(late.tab) && late.tab.message.includes('ms before the browser began fetching it') && late.tab.fix.startsWith('The browser found it late')],
		['the profiler report: the same two', (!plain.report_id || (on_hero(plain.report) && plain.report.fix.startsWith('The file itself'))) && (!late.report_id || (on_hero(late.report) && late.report.fix.startsWith('The browser found it late')))],
		// (the slow hero, then its quick twin: LCP fell, and the part that fell is the download)
		['since your last profile: LCP fell, its download the part', !plain.report_id || (!!since && since.some((v) => v.key === 'lcp' && v.b < v.a && v.part?.label === 'its download' && v.part.b < v.part.a))],
		['since your last load (the Page tab): LCP fell, mostly its download', !!reload && reload.some((m) => m.what === 'LCP' && m.better && m.part?.label === 'its download' && m.part.b < m.part.a)]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} largest paint: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ plain, late, since, reload })}` : ''}`);
	return bad.length ? 0 : 1;
}

/** THE WORST SHIFTS, EXPLAINED (/dt-cls): an image with no size set pushes the text down as it
 *  loads; `?hole`: a hole whose answer is far taller than its fallback does. Each must be named as
 *  the cause of the worst burst, with its fix, in the Page tab and in the profiler's report. */
async function cls_run(browser) {
	const read = async (q) => {
		const rec = await fetch(`${base}/__profiler/page?p=${encodeURIComponent('/dt-cls')}&runs=1`, { redirect: 'manual' }).catch(() => null);
		const report_id = rec?.headers.get('location')?.split('/').pop() ?? null;
		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
		await page.goto(base + '/dt-cls' + q, { waitUntil: 'load' });
		await page.waitForTimeout(3000);
		const tab = await page.evaluate(() => {
			const f = window.__ogygia_page?.()?.report.findings.find((x) => x.code === 'shift-cause');
			return f ? { message: f.message, fix: f.fix } : null;
		});
		await page.goto('about:blank');
		await page.waitForTimeout(300);
		await page.close();
		let report = null;
		for (let i = 0; i < 10 && report_id && !report; i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
			const f = (j?.findings ?? []).find((x) => x.code === 'shift-cause');
			report = f ? { message: f.message, fix: f.fix } : null;
		}
		return { tab, report, report_id };
	};
	const img = await read('');
	const hole = await read('?hole');
	const by_img = (f) => !!f && f.message.includes('right after the image hero.svg arrived') && f.fix.startsWith("Set the image's `width` and `height`");
	const by_hole = (f) => !!f && f.message.includes("right after the hole TallHole's answer swapped in") && f.fix.startsWith('Give the hole a fallback the size of its answer');
	const checks = [
		['an image with no size: named the cause, what moved named', by_img(img.tab) && img.tab.message.includes('what moved was div "Paragraph 1')],
		['a hole taller than its fallback: named the cause', by_hole(hole.tab)],
		['the profiler report: the same two', (!img.report_id || by_img(img.report)) && (!hole.report_id || by_hole(hole.report))]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} worst shifts: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ img, hole })}` : ''}`);
	return bad.length ? 0 : 1;
}

/** THE DOCUMENT HELD OPEN (/dt-stream): the load's `reviews` streams for 1.2 s, the document stays
 *  open, and both islands wake only after its end — Healthy reads nothing late and waits all the
 *  same. Named `page.data.reviews` with both islands, in the Page tab and the profiler's report (its
 *  render now asks as a page navigation, so it streams as a visitor's does: the tail after the
 *  pause). `?quick` settles in 10 ms: nothing said. */
async function stream_run(browser) {
	const rec = await fetch(`${base}/__profiler/page?p=${encodeURIComponent('/dt-stream')}&runs=1`, { redirect: 'manual' }).catch(() => null);
	const report_id = rec?.headers.get('location')?.split('/').pop() ?? null;
	const read = async (q) => {
		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
		await page.goto(base + '/dt-stream' + q, { waitUntil: 'load' });
		await page.waitForTimeout(1500);
		const f = await page.evaluate(() => window.__ogygia_page?.()?.report.findings.find((x) => x.code === 'html-held-open') ?? null);
		await page.goto('about:blank');
		await page.waitForTimeout(300);
		await page.close();
		return f;
	};
	const tab = await read('');
	const quick = await read('?quick');
	let report = null;
	let tail = null;
	for (let i = 0; i < 10 && report_id && !report; i++) {
		await new Promise((ok) => setTimeout(ok, 1000));
		const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
		report = (j?.findings ?? []).find((x) => x.code === 'html-held-open') ?? null;
		tail = j?.strip?.tail ?? null;
	}
	const named = (f) => !!f && f.message.includes('`page.data.reviews`') && f.message.includes('Healthy') && f.message.includes('Reviews') && f.fix.includes("render: 'deferred'");
	const checks = [
		['the Page tab: held by page.data.reviews, both islands waited', named(tab) && tab.fps.length === 2],
		['the quick twin: nothing said', !quick],
		['the profiler: its render streamed, the tail held by reviews', !report_id || (tail?.keys?.some((k) => k.key === 'reviews') && tail.late_ms - tail.early_ms >= 1000)],
		['the profiler report: the same finding, with the server side', !report_id || (named(report) && report.message.includes('on the server the last'))]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} held open: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ tab, quick, report, tail })}` : ''}`);
	return bad.length ? 0 : 1;
}

/** THE FIRST BYTE, EXPLAINED (/dt-ttfb, /dt-ttfb-go): a load that waits 1 s and says why in its
 *  Server-Timing (the database most of it); a redirect that takes 1.1 s before the fast page. Each
 *  named with its step, in the Page tab and in the profiler's report. */
async function ttfb_run(browser) {
	const read = async (path) => {
		const rec = await fetch(`${base}/__profiler/page?p=${encodeURIComponent('/dt-ttfb')}&runs=1`, { redirect: 'manual' }).catch(() => null);
		const report_id = rec?.headers.get('location')?.split('/').pop() ?? null;
		const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		await page.goto(base + path, { waitUntil: 'load' });
		await page.waitForTimeout(2000);
		const tab = await page.evaluate(() => {
			const f = window.__ogygia_page?.()?.report.findings.find((x) => x.code === 'slow-ttfb');
			return f ? { message: f.message, fix: f.fix } : null;
		});
		await page.goto('about:blank');
		await page.waitForTimeout(300);
		await page.close();
		let report = null;
		for (let i = 0; i < 10 && report_id && !report; i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
			const f = (j?.findings ?? []).find((x) => x.code === 'slow-ttfb');
			report = f ? { message: f.message, fix: f.fix } : null;
		}
		return { tab, report, report_id };
	};
	const slow = await read('/dt-ttfb');
	const redirected = await read('/dt-ttfb-go');
	// THE PROFILER, NATIVE IN THE PAGE TAB: no profile yet — the finding says how to find the server's
	// side; one run from the dock's Profiler tab (shared data) — the finding quotes what it found
	let before = null;
	let after = null;
	{
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		const msg = () => page.evaluate(() => window.__ogygia_page?.()?.report.findings.find((f) => f.code === 'slow-ttfb')?.message ?? null);
		await page.goto(base + '/dt-ttfb', { waitUntil: 'load' });
		await page.waitForTimeout(1500);
		before = await msg();
		await page.click('[data-og-panel-toggle]');
		await page.click('[data-og-tab="profiler"]');
		await page.locator('[data-og-profiler] input.n').fill('1');
		await page.click('[data-og-profile-run]');
		await page.locator('[data-og-profile-head]').waitFor({ timeout: 60_000 }).catch(() => {});
		await page.reload({ waitUntil: 'load' });
		await page.waitForTimeout(1500);
		after = await msg();
		await page.close();
	}
	const by_server = (f) => !!f && f.message.includes("ms waiting for the server's answer") && f.message.includes('the database 720 ms') && f.fix.startsWith("The server's answer is the cost");
	const by_redirect = (f) => !!f && f.message.includes('ms in redirects') && f.fix.startsWith('The redirects are the cost');
	const checks = [
		["a slow load: the server's wait, its Server-Timing quoted", by_server(slow.tab)],
		['a slow redirect: the redirect the cost', by_redirect(redirected.tab)],
		['the profiler report: the same two', (!slow.report_id || by_server(slow.report)) && (!redirected.report_id || by_redirect(redirected.report))],
		// (never in the report: it is itself a profile)
		['the report never says to profile the page', !slow.report_id || !slow.report?.message.includes('Profile this page')],
		['the Page tab, no profile yet: says how to find the server’s side', !!before && before.includes('Profile this page (the Profiler tab)')],
		['after one run in the dock: quotes it (the wait, no calls)', !!after && after.includes("The profiler's last run of this page (just now): the server render took") && after.includes('no outbound calls; it says: Mostly waiting')]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} first byte: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ slow, redirected, before, after })}` : ''}`);
	return bad.length ? 0 : 1;
}

/** THE FIRST PAINT, EXPLAINED (/dt-fcp): a head stylesheet answered in 2.4 s blocks it — named as
 *  the costliest part, with the non-blocking fix, in the Page tab and the profiler's report. */
async function fcp_run(browser) {
	const rec = await fetch(`${base}/__profiler/page?p=${encodeURIComponent('/dt-fcp')}&runs=1`, { redirect: 'manual' }).catch(() => null);
	const report_id = rec?.headers.get('location')?.split('/').pop() ?? null;
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	await page.goto(base + '/dt-fcp', { waitUntil: 'load' });
	await page.waitForTimeout(1500);
	const tab = await page.evaluate(() => {
		const f = window.__ogygia_page?.()?.report.findings.find((x) => x.code === 'slow-fcp');
		return f ? { message: f.message, fix: f.fix } : null;
	});
	await page.goto('about:blank');
	await page.waitForTimeout(300);
	await page.close();
	let report = null;
	for (let i = 0; i < 10 && report_id && !report; i++) {
		await new Promise((ok) => setTimeout(ok, 1000));
		const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
		const f = (j?.findings ?? []).find((x) => x.code === 'slow-fcp');
		report = f ? { message: f.message, fix: f.fix } : null;
	}
	const by_css = (f) => !!f && f.message.includes('waiting for a file that blocks the paint (the slowest slow.css') && f.fix.startsWith('The paint waits for slow.css');
	const checks = [
		['the blocking stylesheet named, the costliest part', by_css(tab)],
		['the profiler report: the same', !report_id || by_css(report)]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} first paint: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ tab, report })}` : ''}`);
	return bad.length ? 0 : 1;
}

/** THE TTFB GAP, SPLIT (/dt-gap, the profiler's report): the page renders at once, the app's hooks
 *  hold a visitor's request 900 ms in front of ogygia.handle() (`?front`) or behind it (`?inside`).
 *  The report's ttfb-gap must put the time on the right side of the server's handler. */
async function gap_run(browser) {
	const read = async (mode) => {
		await fetch(`${base}/dt-gap`); // (warm: the gap is the hook's, not a first compile)
		const rec = await fetch(`${base}/__profiler/page?p=${encodeURIComponent('/dt-gap')}&runs=1`, { redirect: 'manual' }).catch(() => null);
		const report_id = rec?.headers.get('location')?.split('/').pop() ?? null;
		if (!report_id) return null;
		const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		await page.goto(`${base}/dt-gap?${mode}`, { waitUntil: 'load' });
		await page.waitForTimeout(1500);
		await page.goto('about:blank');
		await page.waitForTimeout(300);
		await page.close();
		for (let i = 0; i < 10; i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
			const f = (j?.findings ?? []).find((x) => x.code === 'ttfb-gap');
			if (f) return { message: f.message, fix: f.fix };
		}
		return { message: '', fix: '' };
	};
	const front = await read('front');
	const inside = await read('inside');
	const ms_of = (m, label) => {
		const at = m.indexOf(label);
		if (at < 0) return NaN;
		const head = m.slice(0, at).trimEnd();
		return Number(head.slice(head.lastIndexOf(' ') + 1));
	};
	const checks = [
		['held in front of the handler: before it took the request', !front || (ms_of(front.message, " ms before the server's handler took the request") >= 700 && front.fix.startsWith('The request waited before this server took it'))],
		['held behind it: inside the handler, past the render', !inside || (ms_of(inside.message, ' ms inside the handler beyond the render') >= 700 && inside.fix.startsWith('The server held the request past its render'))]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} ttfb gap: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ front, inside })}` : ''}`);
	return bad.length ? 0 : 1;
}

/** HOLES IN ONE BATCH REQUEST: /dt-batch's four holes wake together (`visible`) and go out as one
 *  POST; the fourth is slow on the server. Its wait must be split from its own part of the batch
 *  (the server), never blamed on the browser's request gate. With `og-auth-wall=post` something in
 *  front of ogygia refuses the batch (405): the finding names it and what it cost, and the holes still
 *  fill (each on its own). The open page never says the batch missed. */
async function batch_run(browser) {
	const read = async (wall) => {
		const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
		if (wall) await ctx.addCookies([{ name: 'og-auth-wall', value: wall, url: base }]);
		const page = await ctx.newPage();
		await page.goto(base + '/dt-batch', { waitUntil: 'load' });
		await page.waitForTimeout(3500);
		const all = await page.evaluate(() => (window.__ogygia_page?.()?.report.findings ?? []).map((x) => ({ code: x.code, message: x.message, fix: x.fix })));
		const answered = await page.locator('[data-hole-answer]').count();
		// the Page tab's waterfall: four rows, the slow one's server part drawn
		if (!(await page.locator('[data-og-tab]').count())) await page.click('[data-og-panel-toggle]').catch(() => {});
		await page.waitForTimeout(600);
		await page.click('[data-og-tab="page"]').catch(() => {});
		await page.waitForTimeout(1000);
		const rows = await page.locator('[data-og-page-holes] .row').evaluateAll((rs) => rs.map((r) => [...r.querySelectorAll('.seg')].map((s) => [...s.classList].find((c) => c.startsWith('h-')))));
		// (leave the way a visitor does: the final visit goes out on hide)
		await page.goto('about:blank');
		await page.waitForTimeout(300);
		await ctx.close();
		return { slow: all.filter((x) => x.code === 'hole-slow'), missed: all.filter((x) => x.code === 'hole-batch-missed'), answered, rows };
	};
	// the profiler's report of each visit: the same two findings, from the beacon (no devtools)
	const recorded = async (wall) => {
		const rec = await fetch(`${base}/__profiler/page?p=/dt-batch&runs=1`, { redirect: 'manual' }).catch(() => null);
		const id = rec?.headers.get('location')?.split('/').pop() ?? null;
		const seen = await read(wall);
		let found = { slow: null, missed: null };
		for (let i = 0; id && i < 8 && !(found.slow && (wall ? found.missed : true)); i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${id}.json`)).json().catch(() => null);
			found = { slow: j?.findings?.find((f) => f.code === 'hole-slow') ?? null, missed: j?.findings?.find((f) => f.code === 'hole-batch-missed') ?? null };
		}
		return { ...seen, report: found };
	};
	const open = await recorded(null);
	const walled = await recorded('post');
	const s = open.slow[0]?.message ?? '';
	const m = walled.missed[0];
	const checks = [
		['the slow hole, named once', open.slow.length === 1 && s.startsWith('BatchHole (')],
		['its wait: the server, its part of one request for 4', s.includes('waiting on the server') && s.includes('its part of one request for 4 holes')],
		['never blamed on the request gate', !open.slow.some((f) => f.fix.includes('hole requests at a time'))],
		['the open page: the batch never said to miss', open.missed.length === 0 && open.answered === 4],
		['the waterfall: four rows, a server part on one', open.rows.length === 4 && open.rows.some((segs) => segs.includes('h-server'))],
		['the refused batch: its status, its holes, its cost', walled.missed.length === 1 && m.message.includes('was answered 405') && m.message.includes('BatchHole ×4') && m.message.includes('5 requests instead of 1')],
		['the refused batch: something in front of ogygia', !!m && m.fix.startsWith('Something in front of ogygia.handle()')],
		['the refused batch: the holes still filled', walled.answered === 4],
		['the profiler report: the slow hole, its part of the batch', !!open.report.slow && open.report.slow.message.includes('its part of one request for 4 holes') && !open.report.missed],
		// (four copies of one component: the report names the slow COPY by its props, and that copy's
		// own server render — never the four averaged)
		['the profiler report: the slow copy, its own server render', !!open.report.slow && open.report.slow.message.includes('"slow":true') && /1\.\d s the server render/.test(open.report.slow.message)],
		['the profiler report: the refused batch', !!walled.report.missed && walled.report.missed.message.includes('was answered 405') && walled.report.missed.message.includes('BatchHole ×4')]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} batch: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ open, walled }).slice(0, 1500)}` : ''}`);
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
		// (leave the way a visitor does: the page hides and its final visit goes out — a bare close
		// may not, and the report then drew no lane per hole)
		await page.goto('about:blank');
		await page.waitForTimeout(300);
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
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		// (a few looks: the visit's last message can land a moment after the page left)
		for (let i = 0; i < 5 && clock_lanes.length < 5; i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			await page.goto(`${base}/__profiler/report/${queue_report}`, { waitUntil: 'load' });
			await page.waitForTimeout(1200);
			const sec = page.locator('section:has(h2:text("One clock"))');
			clock_lanes = await sec.locator('text').evaluateAll((t) => t.map((x) => x.textContent ?? '').filter((s) => s.startsWith('QueueHole')));
			clock_amber = await sec.locator('rect[fill="#f59e0b"]').count();
		}
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
	// the report takes the browser visit that follows it
	const record = async (path) => {
		const rec = await fetch(`${base}/__profiler/page?p=${path}&runs=1`, { redirect: 'manual' }).catch(() => null);
		return rec?.headers.get('location')?.split('/').pop() ?? null;
	};
	const named_in = async (id) => {
		if (!id) return undefined;
		for (let i = 0; i < 8; i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${id}.json`)).json().catch(() => null);
			const m = j?.findings?.find((f) => f.code === 'preload-unused')?.message;
			if (m) return m;
		}
		return null;
	};
	const report_id = await record('/dt-preload');
	const lab = await read('/dt-preload');
	const clean = await read('/dt-lab');
	// decoys: a hole's preload answered 500 (the runtime's retries download it again), and a hole the
	// runtime asks for again after Kit rebuilt the page (the preload WAS used)
	const retried = await read('/dt-holes');
	const reasked = await read('/hole-kit-rebuild');
	const in_report = await named_in(report_id);
	// the same lab on a Kit-hydrated page: no runtime, the profiler's inline beacon reports the visit
	const kit_id = await record('/dt-preload-kit');
	if (kit_id) await read('/dt-preload-kit');
	const kit_report = await named_in(kit_id);
	const checks = [
		['the planted preload, named with its bytes', lab.length === 1 && lab[0].message.startsWith('planted (') && lab[0].message.includes('twice')],
		['the fix names crossorigin', lab[0]?.fix.includes('A fetch preload needs `crossorigin`') ?? false],
		['the decoy never', !lab.some((f) => f.message.includes('decoy'))],
		['a page without preloads quiet', clean.length === 0],
		['a failed hole preload, retried: quiet', retried.length === 0],
		['a hole asked again after a rebuild: quiet', reasked.length === 0],
		['the profiler report names it', in_report === undefined || (in_report?.includes('In the browser: planted (') ?? false)],
		['…on a Kit page too', kit_report === undefined || ((kit_report?.includes('In the browser: planted (') ?? false) && !kit_report.includes('decoy'))]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} preloads: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ lab, clean, retried, reasked, in_report, kit_report })}` : ''}`);
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
		// (the first look reads each quoted file's inline map; the next one has the source's lines)
		await page.evaluate(() => window.__ogygia_page?.());
		await page.waitForTimeout(600);
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
	const late_report = await in_report(late_id, "SlowSave's save (SlowSave.svelte:5)");
	const early_id = await record();
	const early = await read('save', false);
	const early_report = await in_report(early_id, "SlowSave's save (SlowSave.svelte:5)");
	const busy = await read('busy', true);
	// the SOURCE's line (`function save()` is line 5): the dev server serves the component compiled, so
	// the frame's own line is the compiled output's — the Page tab maps it through the module's inline
	// map, the profiler through the dev server's client module graph
	const sampled = (m) => !!m && m.includes("(mostly SlowSave's save (SlowSave.svelte:5), ") && m.includes('ms sampled)');
	const checks = [
		['late click (the interaction sampler): the Page tab names save', sampled(late)],
		['late click: the profiler report names save, at its source line', !late_id || sampled(late_report)],
		['early click (the load trace): the Page tab names save', sampled(early)],
		['early click: the profiler report names save', !early_id || sampled(early_report)],
		['queued click: the wait names the timer’s function, run by a timer', !!busy && busy.includes('the main thread was running planted_busy_timer (BusyTimer.svelte:8), ') && busy.includes('run by a timer')]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} interactions sampled: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ late, late_report, early, early_report, busy })}` : ''}`);
	return bad.length ? 0 : 1;
}

/** HELD FOR A FAILING ISLAND (/dt-held): a first-screen island whose module takes 700 ms and then
 *  throws, and a ready island below the fold the scheduler holds for it (viewport first). The wait
 *  is explained: `held-idle` (ogygia's own unexplained wait) must stay quiet, and `queued` must say
 *  what it was held for — in the Page tab and in the profiler's report of the same visit. */
async function held_fail_run(browser) {
	const rec = await fetch(`${base}/__profiler/page?p=/dt-held&runs=1`, { redirect: 'manual' }).catch(() => null);
	const report_id = rec?.headers.get('location')?.split('/').pop() ?? null;
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	await page.goto(base + '/dt-held', { waitUntil: 'load' });
	await page.waitForTimeout(3000);
	const view = await page.evaluate(() => {
		const v = window.__ogygia_page?.();
		return { codes: v?.report.findings.map((f) => f.code) ?? [], queued: v?.report.findings.find((f) => f.code === 'queued')?.message ?? '', held: v?.report.rows.find((r) => r.name === 'BelowReady')?.queue_ms ?? 0 };
	});
	await page.goto('about:blank');
	await page.waitForTimeout(300);
	await page.close();
	let report = null;
	for (let i = 0; i < 10 && report_id && !report?.queued; i++) {
		await new Promise((ok) => setTimeout(ok, 1000));
		const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
		if (j) report = { codes: (j.findings ?? []).map((f) => f.code), queued: (j.findings ?? []).find((f) => f.code === 'queued')?.message ?? '' };
	}
	const says = (m) => m.includes('held for SlowFail (') && m.includes('which then failed) on the first screen');
	const checks = [
		['the hold happened (BelowReady waited for SlowFail)', view.held >= 400],
		['the failing island named', view.codes.includes('hydrate-failed')],
		['never called ogygia’s own wait', !view.codes.includes('held-idle')],
		['queued says what it was held for', says(view.queued)],
		['the profiler report: the same, and no held-idle', !report_id || (!!report && says(report.queued) && !report.codes.includes('held-idle'))]
	];
	const bad = checks.filter(([, ok]) => !ok);
	console.log(`  ${bad.length ? '✗' : '✓'} held for a failing island: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ view, report })}` : ''}`);
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
	// WARM THE SERVER FIRST: a dev server just started compiles each island's module on its first
	// request, so the first visit's islands all wake a second late — true of that visit (and a
	// late-interactive finding then names the decoys), but not what the plants measure. One pass
	// over the lab pages, unmeasured, before any run.
	{
		const warm = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		for (const path of ['/dt-lab', '/dt-third', '/dt-inp', '/dt-held', '/dt-nav-fast', '/dt-nav-slow', '/dt-cache', '/dt-preload', '/dt-styles', '/dt-nest', '/dt-lcp', '/dt-cls', '/dt-ttfb?fast', '/dt-fcp', '/dt-stream?quick']) {
			await warm.goto(base + path, { waitUntil: 'load' }).catch(() => {});
			// (until the islands that wake at load have — their code compiled — or 4 s, which a page with a
			// planted failing island waits out: a fixed 0.7 s left Heavy's first compile to the first
			// measured run, and the slowest wake was its own)
			await warm.waitForFunction(() => !document.querySelector('ogygia-region[wake="load"]:not([data-hydrated])'), null, { timeout: 4000 }).catch(() => {});
			await warm.waitForTimeout(300);
		}
		await warm.close();
	}
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
	// A FINGERPRINT THAT MOVES ON EVERY RENDER (/dt-fp: Stamped's props carry the server's clock):
	// two loads in one tab — the second names Stamped and the prop; Steady (the decoy) never; the first
	// load has nothing to compare
	{
		const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
		const page = await ctx.newPage();
		const read = () => page.evaluate(() => window.__ogygia_page?.()?.report.findings.filter((f) => f.code === 'fp-unstable').map((f) => f.message) ?? []);
		await page.goto(base + '/dt-fp', { waitUntil: 'load' });
		await page.waitForTimeout(1200);
		const first = await read();
		await page.reload({ waitUntil: 'load' });
		await page.waitForTimeout(1200);
		const second = await read();
		await ctx.close();
		// the profiler sees it across its own renders of the page (no browser needed)
		const rec = await fetch(`${base}/__profiler/page?p=/dt-fp&runs=3`, { redirect: 'manual' }).catch(() => null);
		const id = rec?.headers.get('location')?.split('/').pop();
		const j = id ? await (await fetch(`${base}/__profiler/report/${id}.json`)).json().catch(() => null) : null;
		const in_report = j?.findings?.find((f) => f.code === 'fp-unstable')?.message ?? '';
		const ok = first.length === 0 && second.length === 1 && second[0].startsWith('Stamped got a new fingerprint since your last load of this page: its prop `stamp` was') && !second[0].includes('Steady');
		const report_ok = in_report.startsWith("Stamped rendered with a different fingerprint on the profiler's renders of the same page: its prop `stamp`") && !in_report.includes('Steady');
		if (!(ok && report_ok)) failed = true;
		console.log(`${ok && report_ok ? '✓' : '✗'} a fingerprint that moves on every render, its prop named: the Page tab and the profiler report${ok && report_ok ? '' : ` — ${JSON.stringify({ first, second, in_report })}`}`);
	}
	// WHAT AN ISLAND LEFT RUNNING (/dt-leak: Ticker starts an interval and a window listener it never
	// takes back; Tidy takes its own back): nothing on the first load; after an in-app navigation away,
	// Ticker named with both and still running; after a navigation back (a new Ticker), still named
	{
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		const read = () => page.evaluate(() => ({ soft: !!window.__og_key_marker, f: window.__ogygia_page?.()?.report.findings.filter((f) => f.code === 'island-leftover').map((f) => f.message) ?? [] }));
		const go = async (sel) => {
			await page.evaluate((sel) => document.querySelector(sel)?.click(), sel);
			await page.waitForTimeout(1500);
			return read();
		};
		await page.goto(base + '/dt-leak', { waitUntil: 'load' });
		await page.waitForTimeout(1500);
		await page.evaluate(() => (window.__og_key_marker = 1));
		const first = await read();
		const away = await go('[data-leak-go]');
		const back = await go('[data-leak-back]');
		await page.close();
		const named = (r) => r.soft && r.f.length === 1 && r.f[0].startsWith("Ticker left an interval running and a window 'resize' listener attached") && r.f[0].includes('still running') && !r.f[0].includes('Tidy');
		const checks = [
			['the first load quiet', first.f.length === 0],
			['away: Ticker, both, still running', named(away)],
			['back: still Ticker (the copy that left)', named(back)],
			['Tidy never', ![...away.f, ...back.f].some((m) => m.includes('Tidy'))]
		];
		const bad = checks.filter(([, ok]) => !ok);
		if (bad.length) failed = true;
		console.log(`${bad.length ? '✗' : '✓'} what an island left running: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ first, away, back })}` : ''}`);
	}
	// A BIG ISLAND'S CHANGE (/dt-big: ~40 KB islands; BigList's last attribute differs between the
	// server and the browser, BigSteady's never): the change quoted is the real one (`data-track`), not
	// where a 24 KB copy was cut; BigSteady never. Its largest paint repainted nothing (an attribute
	// elsewhere) — while /dt-big-hero's heading, replaced as HeroSwap wakes, did
	{
		const read = async (path) => {
			const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
			await page.goto(base + path, { waitUntil: 'load' });
			await page.waitForTimeout(2000);
			const f = await page.evaluate(() => (window.__ogygia_page?.()?.report.findings ?? []).filter((x) => x.code === 'markup-changed' || x.code === 'lcp-repaint').map((x) => ({ code: x.code, message: x.message })));
			// (the Hydration tab's diff of the big island: the real change, and said to be a window of it)
			const hyd = await page.evaluate(async () => (await window.__ogygia_testing?.hydration())?.islands.find((i) => i.name === 'BigList') ?? null);
			await page.close();
			f.hyd = hyd;
			return f;
		};
		const big = await read('/dt-big');
		const diff_ops = big.hyd?.diff?.hunks?.flatMap((h) => h.ops) ?? [];
		const hero = await read('/dt-big-hero');
		const changed = big.find((f) => f.code === 'markup-changed')?.message ?? '';
		const checks = [
			['BigList, its real change quoted', changed.startsWith('BigList rendered different markup') && changed.includes('server "data-track="') && changed.includes('browser "data-track="')],
			['BigSteady never', !big.some((f) => f.message.includes('BigSteady'))],
			['the Hydration tab: the real change, said to be a window', diff_ops.some((o) => o.op === 'del' && o.text.includes('data-track')) && typeof big.hyd?.window_from === 'number'],
			['no repaint claimed for an attribute', !big.some((f) => f.code === 'lcp-repaint')],
			['the replaced hero: repainted', hero.some((f) => f.code === 'lcp-repaint' && f.message.includes('inside HeroSwap'))]
		];
		const bad = checks.filter(([, ok]) => !ok);
		if (bad.length) failed = true;
		console.log(`${bad.length ? '✗' : '✓'} a big island's change, and a hero repainted: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ big, hero })}` : ''}`);
	}
	// THE DOCK CLOSED COSTS AN IDLE PAGE NOTHING: 5 s of an idle /dt-many (320 islands) with devtools
	// on, the dock closed — the main thread's work stays near a page without devtools (an overlay rAF
	// loop left running asked for a frame sixty times a second: ~90 ms each 5 s)
	{
		const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
		const page = await ctx.newPage();
		const cdp = await ctx.newCDPSession(page);
		await cdp.send('Performance.enable');
		await page.goto(base + '/dt-many', { waitUntil: 'load' });
		await page.waitForTimeout(4000);
		const task = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value;
		const a = await task();
		await page.waitForTimeout(5000);
		const ms = Math.round(((await task()) - a) * 1000);
		await ctx.close();
		const ok = ms < 40;
		if (!ok) failed = true;
		console.log(`${ok ? '✓' : '✗'} the dock closed costs an idle page nothing — ${ms} ms of main-thread work in 5 s idle (limit 40)`);
	}
	// A LONG SESSION OF IN-APP NAVIGATIONS: the Page tab is about the page in view. Nothing of the pages
	// before it carries over (Svelte's warnings from /detector, the slow paint of /dt-lcp); a page after
	// two 320-island visits still has its islands recorded (/dt-lab's planted ones named); and a page
	// SvelteKit's own router brought (a Kit-hydrated document) drops the first page's findings
	{
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		const codes = () => page.evaluate(() => (window.__ogygia_page?.()?.report.findings ?? []).map((f) => f.code));
		const go = async (to, wait = 3500) => {
			await page.evaluate((to) => {
				const a = document.createElement('a');
				a.href = to;
				document.body.prepend(a);
				a.click();
			}, to);
			await page.waitForTimeout(wait);
			return codes();
		};
		await page.goto(base + '/detector', { waitUntil: 'load' });
		await page.waitForTimeout(2500);
		const first = await codes();
		const plain = await go('/plain');
		await go('/dt-lcp', 6000);
		const after_lcp = await go('/plain');
		await go('/dt-many', 5000);
		await go('/plain');
		await go('/dt-many', 5000);
		const lab = await go('/dt-lab', 5000);
		await page.goto(base + '/dt-preload-kit', { waitUntil: 'load' });
		await page.waitForTimeout(2500);
		const kit_first = await codes();
		const kit_next = await go('/score-lab-kit', 3000);
		await page.close();
		const checks = [
			['Svelte’s warnings stay with their page', first.includes('svelte-hydration-warning') && !plain.includes('svelte-hydration-warning')],
			['a slow paint stays with its page', !after_lcp.includes('slow-lcp')],
			['after 640 islands, the next page’s still recorded', lab.includes('hydrate-failed') && lab.includes('markup-changed')],
			['Kit’s own router: the first page’s findings left behind', kit_first.includes('preload-unused') && !kit_next.includes('preload-unused')]
		];
		const bad = checks.filter(([, ok]) => !ok);
		if (bad.length) failed = true;
		console.log(`${bad.length ? '✗' : '✓'} a long session of navigations: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ first, plain, after_lcp, lab, kit_first, kit_next })}` : ''}`);
	}
	// THE LARGEST PAINT MARKED loading="lazy" (/dt-lcp?lazy: the hero lazy, a lazy image far below
	// as the decoy): named on Hero in the Page tab and the profiler's report; the plain hero quiet
	{
		const read = async (q) => {
			const rec = await fetch(`${base}/__profiler/page?p=/dt-lcp&runs=1`, { redirect: 'manual' }).catch(() => null);
			const id = rec?.headers.get('location')?.split('/').pop();
			const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
			await page.goto(base + '/dt-lcp' + q, { waitUntil: 'load' });
			await page.waitForTimeout(3500);
			const tab = await page.evaluate(() => (window.__ogygia_page?.()?.report.findings ?? []).filter((f) => f.code === 'lcp-lazy').map((f) => f.message));
			await page.goto('about:blank');
			let report = null;
			for (let i = 0; i < 6 && id && report === null; i++) {
				await new Promise((ok) => setTimeout(ok, 800));
				const j = await (await fetch(`${base}/__profiler/report/${id}.json`)).json().catch(() => null);
				const f = j?.findings?.find((x) => x.code === 'lcp-lazy');
				if (f) report = f.message;
			}
			await page.close();
			return { tab, report };
		};
		const lazy = await read('?lazy');
		const plain = await read('?quick');
		const checks = [
			['the lazy hero named on Hero', lazy.tab.length === 1 && lazy.tab[0].includes('hero.svg in Hero') && lazy.tab[0].includes('loading="lazy"')],
			['the lazy image far below never', !lazy.tab.some((m) => m.includes('below'))],
			['the profiler report names it', lazy.report?.startsWith('In the browser: The largest paint (img hero.svg in Hero)') ?? false],
			['the plain hero quiet', plain.tab.length === 0]
		];
		const bad = checks.filter(([, ok]) => !ok);
		if (bad.length) failed = true;
		console.log(`${bad.length ? '✗' : '✓'} the largest paint marked lazy: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ lazy, plain })}` : ''}`);
	}
	// IMAGES FAR BELOW THE FIRST SCREEN THAT LOADED AT START (/dt-img-below: right.png?a and ?b 3,000px
	// down, eager — the plants; the hero on the first screen, a lazy copy below, a small one below —
	// the decoys): the two named once as ×2; /dt-img (all on the first screen) quiet
	{
		const read = async (path) => {
			const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
			await page.goto(base + path, { waitUntil: 'load' });
			await page.waitForTimeout(1000);
			const f = await page.evaluate(() => (window.__ogygia_page?.()?.report.findings ?? []).filter((x) => x.code === 'images-eager-below').map((x) => x.message));
			await page.close();
			return f;
		};
		const lab = await read('/dt-img-below');
		const top = await read('/dt-img');
		const checks = [
			['the two eager ones named, once, ×2', lab.length === 1 && lab[0].startsWith('right.png ×2 (')],
			['the hero, the lazy one and the small one never', lab.length === 1 && !lab[0].includes('flat.png') && !lab[0].includes('×3')],
			['a page whose images are on the first screen quiet', top.length === 0]
		];
		const bad = checks.filter(([, ok]) => !ok);
		if (bad.length) failed = true;
		console.log(`${bad.length ? '✗' : '✓'} images below the first screen at start: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ lab, top })}` : ''}`);
	}
	// PRELOADED, NEVER USED (/dt-preload-never: right.png never shown, orphan.woff2 in no @font-face —
	// the plants; flat.png in an <img>, big.png?bg as a CSS background, used.woff2 in an @font-face —
	// the decoys): only the plants named, and only once 3 s have passed since load; /dt-preload's
	// downloaded-twice plant is its own finding, never this one
	{
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		await page.goto(base + '/dt-preload-never', { waitUntil: 'load' });
		const read = () => page.evaluate(() => (window.__ogygia_page?.()?.report.findings ?? []).filter((x) => x.code === 'preload-never-used').map((x) => x.message));
		const early = await read();
		await page.waitForTimeout(3500);
		const late = await read();
		await page.close();
		const twice = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		await twice.goto(base + '/dt-preload', { waitUntil: 'load' });
		await twice.waitForTimeout(3500);
		const other = await twice.evaluate(() => (window.__ogygia_page?.()?.report.findings ?? []).filter((x) => x.code === 'preload-never-used').length);
		await twice.close();
		const m = late[0] ?? '';
		const checks = [
			['right.png and orphan.woff2 named', late.length === 1 && m.startsWith('right.png (image,') && m.includes('orphan.woff2 (font,')],
			['the used ones never', !m.includes('flat.png') && !m.includes('big.png') && !m.includes('used.woff2')],
			['not before 3 s after load', early.length === 0],
			['a preload downloaded twice is not this', other === 0]
		];
		const bad = checks.filter(([, ok]) => !ok);
		if (bad.length) failed = true;
		console.log(`${bad.length ? '✗' : '✓'} preloaded, never used: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ early, late, other })}` : ''}`);
	}
	// A PAGE OF MANY ELEMENTS (/dt-dom: DenseList, an island of ~3,600 — the plant; /dt-dom-static: the
	// same list as page markup; /dt-big: ~1,000): the island named on /dt-dom, the static twin's size
	// named with no island, /dt-big quiet
	{
		const read = async (path) => {
			const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
			await page.goto(base + path, { waitUntil: 'load' });
			await page.waitForTimeout(1000);
			const f = await page.evaluate(() => (window.__ogygia_page?.()?.report.findings ?? []).filter((x) => x.code === 'dom-large').map((x) => ({ m: x.message, fps: x.fps })));
			await page.close();
			return f;
		};
		const lab = await read('/dt-dom');
		const twin = await read('/dt-dom-static');
		const small = await read('/dt-big');
		const checks = [
			['DenseList named, linked', lab.length === 1 && lab[0].m.includes('of them inside DenseList') && lab[0].m.includes('under ul.dense') && lab[0].fps.length === 1],
			['the static twin: its size, no island', twin.length === 1 && !twin[0].m.includes('inside') && twin[0].fps.length === 0],
			['a page of ~1,000 quiet', small.length === 0]
		];
		const bad = checks.filter(([, ok]) => !ok);
		if (bad.length) failed = true;
		console.log(`${bad.length ? '✗' : '✓'} a page of many elements: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ lab, twin, small })}` : ''}`);
	}
	// IMAGES SENT FAR BIGGER THAN SHOWN (/dt-img: big.png 2000×1333 in a 300×200 box — the plant;
	// flat.png the same size but ~11 KB, right.png shown at its size, big.png in a hidden box — the
	// decoys): only big.png named, on a 1× and a 2× screen; a page whose images fit quiet
	{
		const read = async (path, dpr) => {
			const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: dpr });
			await page.goto(base + path, { waitUntil: 'load' });
			await page.waitForTimeout(1000);
			const f = await page.evaluate(() => (window.__ogygia_page?.()?.report.findings ?? []).filter((x) => x.code === 'image-oversized').map((x) => x.message));
			await page.close();
			return f;
		};
		const one = await read('/dt-img', 1);
		const two = await read('/dt-img', 2);
		const clean = await read('/dt-lcp', 1);
		const checks = [
			['big.png named with its sizes', one.length === 1 && one[0].startsWith('big.png (2000×1333, shown at 300×200) is sent far bigger than shown')],
			['the screen counted (2×)', two.length === 1 && two[0].includes('on a 2× screen')],
			['flat / right-sized / hidden never', ![...one, ...two].some((m) => m.includes('flat.png') || m.includes('right.png') || m.includes('more'))],
			['a page whose images fit quiet', clean.length === 0]
		];
		const bad = checks.filter(([, ok]) => !ok);
		if (bad.length) failed = true;
		console.log(`${bad.length ? '✗' : '✓'} images sent far bigger than shown: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ one, two, clean })}` : ''}`);
	}
	// TEXT KEPT INVISIBLE BY ITS FONT (/dt-font: 'SlowFace' without font-display, 'SwapFace' with
	// swap, both files 1.5 s): SlowFace named with its file and how late; SwapFace never; a page with
	// no web font quiet
	{
		const read = async (path) => {
			const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
			await page.goto(base + path, { waitUntil: 'load' });
			await page.waitForTimeout(1500);
			const f = await page.evaluate(() => (window.__ogygia_page?.()?.report.findings ?? []).filter((x) => x.code === 'font-invisible').map((x) => x.message));
			await page.close();
			return f;
		};
		const lab = await read('/dt-font');
		const clean = await read('/dt-lab');
		const checks = [
			['SlowFace named, its file and its wait', lab.length === 1 && lab[0].startsWith("Text in 'SlowFace' (slow.woff2,") && lab[0].includes('font-display is auto')],
			['SwapFace never', !lab.some((m) => m.includes('SwapFace'))],
			['a page without web fonts quiet', clean.length === 0]
		];
		const bad = checks.filter(([, ok]) => !ok);
		if (bad.length) failed = true;
		console.log(`${bad.length ? '✗' : '✓'} text kept invisible by its font: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ lab, clean })}` : ''}`);
	}
	// A LATE PAINT REACHES THE REPORT WITHOUT THE HIDE-TIME MESSAGE (/dt-lcp's slow hero lands after
	// the early visit): the tab is closed hard, no page hide — the visit sent again after the paint
	// carries it, so the profiler's report still names the slow largest paint
	{
		const rec = await fetch(`${base}/__profiler/page?p=/dt-lcp&runs=1`, { redirect: 'manual' }).catch(() => null);
		const id = rec?.headers.get('location')?.split('/').pop();
		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
		await page.goto(base + '/dt-lcp', { waitUntil: 'load' });
		await page.waitForTimeout(5500);
		await page.close({ runBeforeUnload: false });
		let named = false;
		for (let i = 0; i < 6 && id && !named; i++) {
			await new Promise((ok) => setTimeout(ok, 800));
			const j = await (await fetch(`${base}/__profiler/report/${id}.json`)).json().catch(() => null);
			named = !!j?.findings?.some((f) => f.code === 'slow-lcp');
		}
		const ok = !id || named;
		if (!ok) failed = true;
		console.log(`${ok ? '✓' : '✗'} a late paint reaches the report with the tab closed hard (the visit sent again)`);
	}
	// WHAT A SERVER RENDER LEFT RUNNING (/dt-timers: each render starts an interval and a 30 s timer it
	// never ends; one process-wide interval and a cleared per-request timer are the decoys): the
	// profiler's report names both plants, on their lines; neither decoy; a page without timers quiet
	{
		const leftovers_of = async (path) => {
			const rec = await fetch(`${base}/__profiler/page?p=${path}&runs=3`, { redirect: 'manual' }).catch(() => null);
			const id = rec?.headers.get('location')?.split('/').pop();
			const j = id ? await (await fetch(`${base}/__profiler/report/${id}.json`)).json().catch(() => null) : null;
			return j ? j.findings.filter((f) => f.code === 'render-leftover').map((f) => `${f.message} @${f.line}`) : null;
		};
		const lab = await leftovers_of('/dt-timers');
		const clean = await leftovers_of('/dt-lab');
		const checks = lab
			? [
					['the interval, on its line', lab.some((m) => m.startsWith('Each render starts an interval (every 1 s)') && m.includes('poll_prices') && m.endsWith('@9'))],
					['the 30 s timer, on its line', lab.some((m) => m.startsWith('Each render schedules a 30 s timer') && m.includes('expire_later') && m.endsWith('@15'))],
					['no decoy', lab.length === 2 && !lab.some((m) => m.includes('sweep_once') || m.includes('every 5 s') || m.includes('5 s timer'))],
					['a page without timers quiet', clean?.length === 0]
				]
			: [['the profiler answered', false]];
		const bad = checks.filter(([, ok]) => !ok);
		if (bad.length) failed = true;
		console.log(`${bad.length ? '✗' : '✓'} what a server render left running: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}${bad.length ? ` — ${JSON.stringify({ lab, clean })}` : ''}`);
	}
	// A HOST UPGRADED BEFORE THE RESTORE (/dt-restore: a blocking head script defines `demo-card`): the
	// late restore named with the island it broke; the `demo-link` beside it (restored fine) never
	{
		// (the profiler records this visit too: its report must say the same, from the beacon)
		const rec = await fetch(`${base}/__profiler/page?p=/dt-restore&runs=1`, { redirect: 'manual' }).catch(() => null);
		const report_id = rec?.headers.get('location')?.split('/').pop() ?? null;
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		await page.goto(base + '/dt-restore', { waitUntil: 'load' });
		await page.waitForTimeout(2500);
		const r = await page.evaluate(() => ({
			transformed: !!window.__og_restore_log || document.querySelector('demo-link')?.shadowRoot !== null,
			late: window.__ogygia_page?.()?.report.findings.filter((f) => f.code === 'restore-late').map((f) => f.message) ?? []
		}));
		await page.goto('about:blank');
		await page.waitForTimeout(300);
		await page.close();
		let in_report = null;
		for (let i = 0; report_id && r.transformed && i < 8 && !in_report; i++) {
			await new Promise((ok) => setTimeout(ok, 1000));
			const j = await (await fetch(`${base}/__profiler/report/${report_id}.json`)).json().catch(() => null);
			in_report = j?.findings?.find((f) => f.code === 'restore-late')?.message ?? null;
		}
		const ok = r.late.length === 1 && r.late[0].startsWith('<demo-card> was upgraded by its component before ogygia restored it') && r.late[0].includes('LateCard') && !r.late[0].includes('demo-link');
		const report_ok = !!in_report && in_report.includes('<demo-card> was upgraded by its component');
		if (r.transformed && !(ok && report_ok)) failed = true;
		console.log(`${!r.transformed ? '·' : ok && report_ok ? '✓' : '✗'} a host upgraded before the restore${!r.transformed ? ' (skipped: start the server with OGYGIA_RESTORE_LAB=1)' : ok && report_ok ? ': the Page tab and the profiler report' : ` — ${JSON.stringify({ ...r, in_report })}`}`);
	}
	// KIT'S COPY OF THE SERVER LOAD DATA (/bench-cms: csr=false, a 250 KB server load): Kit unevals it
	// on every request and drops it — named so, apart from ogygia's own serialization (never twice)
	{
		const rec = await fetch(`${base}/__profiler/page?p=/bench-cms&runs=3`, { redirect: 'manual' }).catch(() => null);
		const id = rec?.headers.get('location')?.split('/').pop();
		const j = id ? await (await fetch(`${base}/__profiler/report/${id}.json`)).json().catch(() => null) : null;
		const k = j?.findings?.find((f) => f.code === 'kit-uneval');
		const ok = !!k && k.message.includes('On a csr=false page nothing reads that copy') && k.fix.startsWith('Only less load data helps');
		if (!ok) failed = true;
		console.log(`${ok ? '✓' : '✗'} Kit's copy of a csr=false page's load data: built and dropped${ok ? '' : ` — ${JSON.stringify(k)}`}`);
	}
	// A BARE ATTRIBUTE ON A CUSTOM ELEMENT (/restore-lab's `<demo-card data-lab-card>`): the server
	// writes "", Svelte's hydrate "true" — the markup change is named with that cause and its fix
	{
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		await page.goto(base + '/restore-lab', { waitUntil: 'load' });
		await page.waitForTimeout(2500);
		const fix = await page.evaluate(() => window.__ogygia_page?.()?.report.findings.find((f) => f.code === 'markup-changed')?.fix ?? '');
		await page.close();
		const ok = fix.startsWith('`data-lab-card` on <demo-card> is written bare') && fix.includes('`data-lab-card=""`');
		if (!ok) failed = true;
		console.log(`${ok ? '✓' : '✗'} a bare attribute on a custom element, named as the cause${ok ? '' : ` — ${fix}`}`);
	}
	let batch_ok = 0;
	for (let i = 0; i < repeat; i++) batch_ok += await batch_run(browser);
	if (batch_ok < repeat) failed = true;
	console.log(`${batch_ok === repeat ? '✓' : '✗'} holes in one batch request: ${batch_ok}/${repeat}`);
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
	let gap_ok = 0;
	for (let i = 0; i < repeat; i++) gap_ok += await gap_run(browser);
	if (gap_ok < repeat) failed = true;
	console.log(`${gap_ok === repeat ? '✓' : '✗'} the ttfb gap, split: ${gap_ok}/${repeat}`);
	let fcp_ok = 0;
	for (let i = 0; i < repeat; i++) fcp_ok += await fcp_run(browser);
	if (fcp_ok < repeat) failed = true;
	console.log(`${fcp_ok === repeat ? '✓' : '✗'} the first paint, explained: ${fcp_ok}/${repeat}`);
	let stream_ok = 0;
	for (let i = 0; i < repeat; i++) stream_ok += await stream_run(browser);
	if (stream_ok < repeat) failed = true;
	console.log(`${stream_ok === repeat ? '✓' : '✗'} the document held open, explained: ${stream_ok}/${repeat}`);
	let ttfb_ok = 0;
	for (let i = 0; i < repeat; i++) ttfb_ok += await ttfb_run(browser);
	if (ttfb_ok < repeat) failed = true;
	console.log(`${ttfb_ok === repeat ? '✓' : '✗'} the first byte, explained: ${ttfb_ok}/${repeat}`);
	let cls_ok = 0;
	for (let i = 0; i < repeat; i++) cls_ok += await cls_run(browser);
	if (cls_ok < repeat) failed = true;
	console.log(`${cls_ok === repeat ? '✓' : '✗'} the worst shifts, explained: ${cls_ok}/${repeat}`);
	let lcp_ok = 0;
	for (let i = 0; i < repeat; i++) lcp_ok += await lcp_run(browser);
	// (two in three, like the other report checks: on a dev server that had re-run the app's hooks, a
	// profile could keep no island rows — two profilers' windows shared one detail switch; it is
	// counted now — and its report named the island by its file. A miss prints its report's rows)
	const lcp_need = repeat >= 3 ? repeat - 1 : repeat;
	if (lcp_ok < lcp_need) failed = true;
	console.log(`${lcp_ok >= lcp_need ? '✓' : '✗'} the largest paint, split: ${lcp_ok}/${repeat}`);
	let nav_slow_ok = 0;
	for (let i = 0; i < repeat; i++) nav_slow_ok += await nav_slow_run(browser);
	if (nav_slow_ok < repeat) failed = true;
	console.log(`${nav_slow_ok === repeat ? '✓' : '✗'} a slow in-app navigation, split: ${nav_slow_ok}/${repeat}`);
	let held_fail_ok = 0;
	for (let i = 0; i < repeat; i++) held_fail_ok += await held_fail_run(browser);
	if (held_fail_ok < repeat) failed = true;
	console.log(`${held_fail_ok === repeat ? '✓' : '✗'} held for a failing island, explained: ${held_fail_ok}/${repeat}`);
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
