// DEVTOOLS IN A BUILD (a preview deploy with `devtools: true`): a visitor gets the launcher only (no
// dock code, no server side-channel, no measuring); opening it loads the dock; from the next load
// that browser is measured from the start and gets the server's events. Exit 1 on a failure.
//
//   cd apps/playground && OGYGIA_DEVTOOLS=1 pnpm build
//   node node_modules/vite/bin/vite.js preview --port 4181 --host 127.0.0.1
//   node internal/bench/devtools-build-check.mjs [base=http://127.0.0.1:4181]
//   (rebuild without OGYGIA_DEVTOOLS afterwards: the e2e suite expects devtools off in the build)
import { createRequire } from 'node:module';

const base = process.argv[2] ?? 'http://127.0.0.1:4181';
const { chromium } = createRequire(new URL('../../package.json', import.meta.url))('playwright');
const results = [];
const check = (name, ok, extra = '') => {
	results.push(ok);
	console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const html = await (await fetch(base + '/dt-lab')).text();
check('a visitor\'s HTML has no server side-channel', !html.includes('application/ogygia-devtools'));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => !e.message.includes('planted') && errors.push(e.message));
let loaded = [];
page.on('response', (r) => r.url().endsWith('.js') && loaded.push(r.url()));

await page.goto(base + '/dt-lab', { waitUntil: 'load' });
// (the launcher is a lazy chunk: on a server's cold first requests it can take past a fixed wait)
await page.waitForSelector('[data-og-panel-toggle]', { timeout: 10_000 }).catch(() => {});
await page.waitForTimeout(500);
check('the launcher is there', (await page.locator('[data-og-panel-toggle]').count()) === 1);
check('no dock until opened', (await page.locator('[data-og-win]').count()) === 0 && (await page.evaluate(() => typeof window.__ogygia_page)) === 'undefined');

loaded = [];
await page.locator('[data-og-panel-toggle]').click();
await page.waitForTimeout(1500);
check('opening loads the dock\'s code then', loaded.length >= 1, `${loaded.length} file(s)`);
check('the dock opens with its tabs', (await page.locator('[data-og-tab]').count()) >= 7);
check('the cookie remembers it', (await ctx.cookies()).some((c) => c.name === 'og_devtools' && c.value === '1'));
await page.locator('[data-og-tab="page"]').click();
await page.waitForTimeout(400);
check('the Page tab asks for a reload on the first open', (await page.locator('[data-og-page-unmeasured]').count()) === 1);

await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(3500);
const view = await page.evaluate(() => {
	const v = window.__ogygia_page?.();
	return v ? v.report.findings.map((f) => f.code) : null;
});
check('after a reload the page is measured from the start', !!view && view.includes('long-hydrate') && view.includes('markup-changed'), JSON.stringify(view));
const server = await page.evaluate(() => (window.__ogygia_devtools?.events() ?? []).filter((e) => e.realm === 'server').length);
check('…and gets the server\'s events', server > 0, `${server}`);
check('island names come from the build', (await page.evaluate(() => Object.keys(window.__ogygia_region_names ?? {}).length)) > 0);
// a JS file is script, whatever fetched it (a link initiator read as a stylesheet put a hole's
// preload in the CSS column; a modulepreload must never go the same way)
const js_as_css = await page.evaluate(() => (window.__ogygia_page?.()?.page.visit?.resources ?? []).filter((r) => r.type === 'css' && /\.m?js(\?|$)/.test(r.url)).map((r) => r.url.split('/').pop()));
const preloaded = await page.evaluate(() => document.querySelectorAll('link[rel="modulepreload"]').length);
check('a modulepreloaded JS file counts as script, not CSS', js_as_css.length === 0, `${js_as_css.length} of the page's JS as CSS (${preloaded} modulepreload links): ${js_as_css.slice(0, 4).join(', ')}`);
// THE BYTES TAB in a build: the exact ledger from the page's island graph, and its page total is
// the real files' bytes (each once), checked against the files fetched straight from the server
await page.locator('[data-og-tab="bytes"]').click();
await page.waitForTimeout(600);
check('Bytes: the exact ledger (island graph × the browser\'s sizes)', (await page.locator('[data-og-ledger-exact]').count()) === 1);
// the build's names reach every tab (a built entry is og-region.<id>.js; the names key the bare id)
const ledger_names = await page.locator('[data-og-ledger-exact] + table tbody .nm').allInnerTexts();
check('the tabs name islands by their component in a build', ledger_names.includes('Heavy') && !ledger_names.some((n) => n.startsWith('og-region')), ledger_names.join(', '));
const decoded_text = await page.locator('[data-og-ledger-exact] + table tfoot td').last().innerText().catch(() => '');
const files = await page.evaluate(() => {
	const abs = (h) => new URL(h, location.href).href;
	const set = new Set();
	for (const s of document.querySelectorAll('script[data-ogygia-graph]')) {
		const w = JSON.parse(s.textContent);
		for (const ids of Object.values(w.e)) for (const i of ids) set.add(abs(w.h[i]));
	}
	// each island's own file: its location (`src`) — the graph keys islands by identity, a name the
	// browser never loads
	for (const r of document.querySelectorAll('ogygia-region[src]')) set.add(abs(r.getAttribute('src')));
	const rt = document.querySelector('script[data-ogygia-runtime]')?.getAttribute('src');
	if (rt) set.add(abs(rt));
	for (const l of document.querySelectorAll('link[data-ogygia-runtime-dep]')) set.add(abs(l.getAttribute('href')));
	const loaded = new Set(performance.getEntriesByType('resource').map((r) => r.name));
	// only the islands on THIS page count (a graph may list more entries than the page shows)
	return [...set].filter((u) => loaded.has(u));
});
let on_disk = 0;
for (const u of files) on_disk += (await (await fetch(u)).arrayBuffer()).byteLength;
const shown_kb = Number.parseFloat(decoded_text);
check('Bytes: the page total is the real files, each once', Math.abs(shown_kb - on_disk / 1024) <= 0.2, `shown ${decoded_text}, the ${files.length} loaded files are ${(on_disk / 1024).toFixed(1)} kB`);
// an island's detail card carries its line of the ledger: its code, what only it needs, whom it shares with
await page.locator('[data-og-tab="lens"]').click();
await page.waitForTimeout(400);
await page.locator('[data-og-win] tbody tr', { hasText: 'Heavy' }).first().click();
await page.waitForTimeout(600);
const detail_bytes = await page.locator('[data-og-detail]').innerText().catch(() => '');
check('an island card shows its code: files, only it, shared with', detail_bytes.includes('its code') && detail_bytes.includes('only it') && detail_bytes.includes('shared'), detail_bytes.split('\n').filter((l) => l.includes('code') || l.includes('only it') || l.includes('shared')).join(' | ').slice(0, 200));
// STYLES in a build: the Page tab reads the page's sheets (devtools' own never among them), the
// planted unscoped fallback is named, and a clean page raises nothing
const styles_of = () =>
	page.evaluate(async () => {
		const r = await window.__ogygia_styles?.();
		return r ? { codes: r.findings.map((f) => f.code), unscoped: r.report.unscoped.map((u) => u.file), sheets: r.report.sheets.map((s) => `${s.label} ${s.unmatched}/${s.rules}`) } : null;
	});
const clean_styles = await styles_of();
check('Styles: a clean page raises nothing (devtools\' own sheets left out)', !!clean_styles && clean_styles.codes.length === 0, JSON.stringify(clean_styles));
await page.goto(base + '/dt-styles', { waitUntil: 'load' });
await page.waitForTimeout(1500);
const lab_styles = await styles_of();
check('Styles: the planted unscoped component and the unmatched sheet are named', !!lab_styles && lab_styles.unscoped.join() === 'LabCard.svelte' && lab_styles.codes.includes('css-unmatched'), JSON.stringify(lab_styles));
await page.locator('[data-og-tab="page"]').click();
await page.waitForTimeout(800);
check('Styles: the Page tab shows the sheets and the unscoped line', (await page.locator('[data-og-page-styles]').count()) === 1 && (await page.locator('[data-og-page-unscoped]').innerText().catch(() => '')).includes('LabCard.svelte'));
// CACHE HEADERS: the islands' files and the runtime are named by their content; the host must cache
// them for good. Served as the build serves them (SvelteKit's immutable policy): quiet. The same
// page through a planted proxy that rewrites them to `no-cache`: named, with the header seen.
{
	const cache_of = (p) =>
		p.evaluate(async () => {
			const r = await window.__ogygia_cache?.();
			return r ? { files: r.probes.length, headers: [...new Set(r.probes.map((x) => x.cache_control))], findings: r.findings.map((f) => f.message) } : null;
		});
	await page.goto(base + '/dt-lab', { waitUntil: 'load' });
	await page.waitForTimeout(800);
	const clean = await cache_of(page);
	check('Cache: every content-named file is probed, and the build’s immutable policy is quiet', !!clean && clean.files >= 3 && clean.findings.length === 0, JSON.stringify(clean));
	const planted = await ctx.newPage();
	await planted.route(
		(url) => url.pathname.includes('/_app/immutable/og-'),
		async (route) => {
			const res = await route.fetch();
			await route.fulfill({ response: res, headers: { ...res.headers(), 'cache-control': 'no-cache' } });
		}
	);
	await planted.goto(base + '/dt-lab', { waitUntil: 'load' });
	await planted.waitForTimeout(1200);
	const bad = await cache_of(planted);
	check(
		'Cache: a proxy that serves them `no-cache` is named, with the header and the runtime',
		// every probed file counted; the heaviest (the runtime) named first
		!!bad && bad.findings.length === 1 && bad.findings[0].startsWith(`${bad.files} of the page's content-named files (the runtime, `) && bad.findings[0].includes('`no-cache`') && !bad.findings[0].includes('og-region'),
		JSON.stringify(bad)
	);
	await planted.close();
}
// THE SLOWEST INTERACTION in a build: chunk names are hashes and functions are minified, so the
// explanation must name islands by the build's names — the clicked one, and the one whose timer the
// click waited behind (its script file is that island's own)
{
	const inp_of = async (mode) => {
		const p = await ctx.newPage();
		await p.goto(base + '/dt-inp', { waitUntil: 'load' });
		await p.waitForTimeout(1500);
		const center = async (sel) => {
			const b = await p.locator(sel).boundingBox();
			return [b.x + b.width / 2, b.y + b.height / 2];
		};
		if (mode === 'save') await p.mouse.click(...(await center('[data-inp="save"]')));
		else {
			const count = await center('[data-inp="count"]');
			await p.mouse.click(...(await center('[data-inp="busy"]')));
			await p.waitForTimeout(80);
			await p.mouse.click(...count);
		}
		await p.waitForTimeout(1000);
		const m = await p.evaluate(() => window.__ogygia_page?.()?.report.findings.find((f) => f.code === 'slow-interaction')?.message ?? null);
		await p.close();
		return m;
	};
	const save = await inp_of('save');
	check('INP in a build: the slow handler, on SlowSave, its own handler', !!save && save.includes('in SlowSave') && save.includes("SlowSave's own click handler"), save ?? 'no finding');
	const busy = await inp_of('busy');
	check('INP in a build: the queued click names BusyTimer’s timer, not a chunk hash', !!busy && busy.includes('in QuickCount') && busy.includes('BusyTimer') && busy.includes('a timer'), busy ?? 'no finding');
	// a click after the load, sampled: the page cannot source-map a build's frames, so a minified
	// function in a chunk is never quoted — the frames' reading stands
	{
		const p = await ctx.newPage();
		await p.goto(base + '/dt-inp', { waitUntil: 'load' });
		const state = await p.waitForFunction(() => window.__ogygia_page?.()?.page.cpu.state === 'done', null, { timeout: 30_000 }).then(() => 'done').catch(() => 'no trace');
		await p.waitForTimeout(500);
		const b = await p.locator('[data-inp="save"]').boundingBox();
		await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
		await p.waitForTimeout(1500);
		const r = await p.evaluate(() => ({ traces: window.__ogygia_page?.()?.page.cpu.traces.map((t) => t.label) ?? [], m: window.__ogygia_page?.()?.report.findings.find((f) => f.code === 'slow-interaction')?.message ?? null }));
		await p.close();
		check('INP in a build, sampled after the load: no minified function quoted', !!r.m && r.m.includes("SlowSave's own click handler") && !r.m.includes('sampled'), JSON.stringify({ state, ...r }));
	}
}
check('no errors', errors.length === 0, errors.slice(0, 2).join(' | '));
// HOLES IN ONE BATCH, in a build: /dt-batch's four `visible` holes go out as ONE request (the
// built runtime's batching, not dev's), and the Page tab reads the slow one's wait from its own part
// of it — the server, never the browser's request gate.
{
	const p = await ctx.newPage();
	const posts = [];
	p.on('request', (r) => { if (r.url().includes('__ogygia__')) posts.push(r.method()); });
	await p.goto(base + '/dt-batch', { waitUntil: 'load' });
	await p.waitForTimeout(3000);
	const slow = await p.evaluate(() => window.__ogygia_page?.()?.report.findings.find((f) => f.code === 'hole-slow')?.message ?? null);
	check('Batch: four visible holes, one request', posts.filter((m) => m === 'POST').length === 1 && !posts.includes('GET'), posts.join(','));
	check('Batch: the slow hole, its part of the batch', !!slow && slow.includes('its part of one request for 4 holes') && slow.includes('BatchHole'), String(slow));
	await p.close();
}

// THE OBSERVER EFFECT: measuring (the og_devtools cookie) must not change what it measures. The
// same heavy page, loaded with and without it, one after the other (a server that drifts over the
// run would bias blocks); the page's own main-thread time and its HTML size, medians of 6 each.
{
	const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
	const runs = { off: [], on: [] };
	for (let i = 0; i < 6; i++) {
		for (const mode of i % 2 ? ['on', 'off'] : ['off', 'on']) {
			const c = await browser.newContext({ viewport: { width: 1400, height: 900 } });
			if (mode === 'on') await c.addCookies([{ name: 'og_devtools', value: '1', url: base }]);
			const p = await c.newPage();
			const cdp = await c.newCDPSession(p);
			await cdp.send('Performance.enable');
			await p.goto(base + '/hell-fixed', { waitUntil: 'load' });
			await p.waitForTimeout(1500);
			const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
			const html = await p.evaluate(() => performance.getEntriesByType('navigation')[0].transferSize);
			runs[mode].push({ task: m.TaskDuration * 1000, html });
			await c.close();
		}
	}
	const task = med(runs.on.map((r) => r.task)) - med(runs.off.map((r) => r.task));
	const html = med(runs.on.map((r) => r.html)) - med(runs.off.map((r) => r.html));
	check('measuring costs the page little: its main thread and its HTML', task <= 60 && html <= 4096, `+${Math.round(task)} ms main thread, +${(html / 1024).toFixed(1)} KB HTML`);
}
await browser.close();

const failed = results.filter((r) => !r).length;
console.log(failed ? `FAILED (${failed})` : 'devtools in a build: launcher only until opened');
process.exit(failed ? 1 : 0);
