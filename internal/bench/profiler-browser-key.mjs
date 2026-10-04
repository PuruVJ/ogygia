// THE PROFILER'S BROWSER ANSWER KEY: what a visiting browser measures reaches the profiler's report —
// each lab page is profiled, visited once by a real browser (its beacon sends the visit), and the
// report must name the lab's planted problem in the browser's words; the decoy pages must stay
// quiet on those codes. The same findings the devtools Page tab makes (page-insights.ts), through
// the beacon → visit.ts → browser-findings.ts path, in a build.
//
//   node internal/bench/profiler-browser-key.mjs [--build]      (a fresh preview on 4188 per run)
//   node internal/bench/profiler-browser-key.mjs http://127.0.0.1:4181 hell   (one you started)
//
// Exit code 1 on a failure.
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const PORT = 4188;
const base = args[0] ?? `http://127.0.0.1:${PORT}`;
const key = args[1] ?? 'hell';
const serve = !args[0];
const app = fileURLToPath(new URL('../../apps/playground', import.meta.url));
const { chromium, webkit } = createRequire(new URL('../../package.json', import.meta.url))('playwright');

/** each lab: the page to visit (its path as recorded: the bare path, a query only on the visit),
 *  how long to stay, the codes that must be named (with what each message must say), and the codes
 *  that must not appear */
const LABS = [
	{ path: '/dt-font', stay: 3500, named: { 'font-invisible': "Text in 'SlowFace'" }, never: { 'font-invisible': 'SwapFace' } },
	// (its unsized image sits in a hidden parent: the visit's look drops the HTML's guess)
	{ path: '/dt-img', stay: 2000, named: { 'image-oversized': 'big.png (2000×1333, shown at 300×200)' }, never: { 'image-oversized': 'flat.png' }, absent: ['img-unsized'] },
	{ path: '/dt-cls', stay: 2500, named: { 'img-unsized': 'hero.svg' } },
	{ path: '/dt-img-below', stay: 2000, named: { 'images-eager-below': 'right.png ×2 (' }, never: { 'images-eager-below': 'flat.png' } },
	{ path: '/dt-dom', stay: 2000, named: { 'dom-large': 'of them inside DenseList' } },
	{ path: '/dt-preload-never', stay: 5000, named: { 'preload-never-used': 'right.png (image,' }, never: { 'preload-never-used': 'flat.png' } },
	// (its effects are Thrash's own work: never "outside any island", never "the scheduler held it";
	// Batched waits behind Thrash when its code came in time to wait at all — a cold load varies)
	{ path: '/dt-thrash', stay: 2500, named: { 'forced-layout': 'Thrash while it hydrated (', 'long-hydrate': 'Thrash (' }, never: { queued: 'scheduler' }, absent: ['held-idle', 'long-tasks'] },
	// (the browser's slow-lcp carries the split; the report's own lcp-gap, beside it, the server's verdict only)
	{ path: '/dt-lcp', query: '?below', stay: 5000, named: { 'slow-lcp': 'Beside it, ', 'lcp-gap': 'the server is not the bottleneck' }, never: { 'lcp-gap': 'Beside it' }, fix_never: { 'slow-lcp': 'CSS background' } },
	// (the largest paint a CSS background its slow stylesheet names: found late, and why — the fix)
	{ path: '/dt-lcp-bg', stay: 4000, fix_says: { 'slow-lcp': 'It is a CSS background image (on the div)' } },
	// (scrolled with the wheel after load: the beacon sends the jank again, the page never hides)
	// (a build's handler is a minified name in a hashed chunk: named by the island whose file it is)
	{ path: '/dt-jank', stay: 3000, scroll: true, named: { 'scroll-jank': "Janky's code, run by" }, never: { 'scroll-jank': 'Calm' } },
	// (a click whose handler reads sizes between writes: how much of it was forced layout, by its island)
	{ path: '/dt-inp-thrash', stay: 2000, click: '[data-inp="thrash"]', named: { 'slow-interaction': "ThrashSort's own click handler; " }, fix_says: { 'slow-interaction': 'Much of the handler is forced layout' } },
	// (a handler that is just busy: its own work, never called forced layout)
	{ path: '/dt-inp', stay: 2000, click: '[data-inp="save"]', named: { 'slow-interaction': "(mostly SlowSave's own click handler)" }, fix_says: { 'slow-interaction': 'The handler itself is the cost' } },
	// (the server's own answer: the page's Cache-Control, read off the profiled render)
	{ path: '/dt-nostore', stay: 1000, named: { 'bfcache-no-store': 'Cache-Control: no-store' } },
	// (the same page every render: "cache it", but a hook's cookie on the answer must be named first;
	// its control, the same page with no cookie, never — the pattern's fix, `fixes`, not a finding)
	{ path: '/dt-cookie', stay: 500, runs: 3, fixes: { 'same-document': 'sets a cookie (Set-Cookie)' } },
	{ path: '/dt-cookie-free', stay: 500, runs: 3, fixes: { 'same-document': 'Set Cache-Control with s-maxage' }, fixes_never: { 'same-document': 'Set-Cookie' } },
	// (a script and a fetch the server answered `Content-Encoding: identity`; the page itself compressed)
	{ path: '/dt-raw', stay: 2500, named: { uncompressed: 'blob.js (script, ' }, never: { uncompressed: "the page's HTML" } },
	// the quiet ones: none of the codes above
	// (its one eager island below the fold: named with its own bytes, from the build's weights)
	// (and Clock's markup change, by the line of its own that draws differently in the browser)
	{ path: '/dt-lab', stay: 2500, named: { 'eager-offscreen': 'BelowEager starts below the first screen but loads code at page load. Only ', 'markup-changed': 'Clock.svelte:3 (`const where = typeof window' }, fix_says: { 'markup-changed': 'Read the browser-only value after the wake' }, absent: ['font-invisible', 'image-oversized', 'images-eager-below', 'dom-large', 'preload-never-used', 'forced-layout', 'bfcache-no-store', 'uncompressed'] },
	{ path: '/dt-big', stay: 2000, absent: ['dom-large', 'image-oversized', 'forced-layout'] },
	// one module by two paths (a package's src and its dist), both copies on the page; the decoy
	// loads one copy (the workspace's own ogygia src/dist pair may still be named there — never dup-pkg)
	{ path: '/dt-dupe', stay: 1500, named: { 'duplicate-module': 'from dup-pkg/dist' }, fix_says: { 'duplicate-module': 'import the package by its public entry everywhere' } },
	{ path: '/dt-dupe-one', stay: 1500, never: { 'duplicate-module': 'dup-pkg' } },
	// (WebKit: every other origin's file 0 bytes and no word of what held the first paint — the report
	// weighs the files the page names and reads the blocking ones off its HTML, as Chromium tells it)
	// (WebKit: no long-task timing — the planted stall is found from the frames drawn late, said so)
	{ path: '/dt-lab', engine: 'webkit', stay: 2500, named: { 'long-tasks': 'the frames it drew more than 50 ms late', 'browser-limits': 'estimated from the frames it drew late' } },
	{ path: '/dt-third', engine: 'webkit', stay: 3500, named: { 'third-party': 'were weighed from the files themselves', 'third-party-blocking': 'held the first paint', 'third-party-edits': 'ThirdTarget' }, never: { 'third-party': ' 0 KB' } }
];

async function start_preview() {
	const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
		cwd: app,
		env: { ...process.env, OGYGIA_PROFILER_SECRET: key, ORIGIN: base },
		stdio: 'ignore'
	});
	for (let i = 0; i < 120; i++) {
		try {
			await fetch(base + '/');
			return () => child.kill();
		} catch {
			await new Promise((r) => setTimeout(r, 500));
		}
	}
	child.kill();
	throw new Error('the preview did not start');
}

if (flags.includes('--build')) {
	execSync('pnpm build', { cwd: fileURLToPath(new URL('../../packages/ogygia', import.meta.url)), stdio: 'inherit' });
	execSync('pnpm build', { cwd: app, stdio: 'inherit' });
}
const stop = serve ? await start_preview() : () => {};
const browser = await chromium.launch();
/** another engine, launched for the first lab that asks for it */
const engines = { chromium: browser };
const engine_of = async (name = 'chromium') => (engines[name] ??= await { webkit }[name].launch());
const headers = { 'x-profiler-key': key };
let failed = 0;
/** the largest visit body any lab's beacon sent */
let biggest = 0;
const VISIT_BUDGET = 30_000;
try {
	for (const lab of LABS) {
		const rec = await fetch(`${base}/__profiler/page?p=${encodeURIComponent(lab.path)}&runs=${lab.runs ?? 1}`, { redirect: 'manual', headers });
		const id = rec.headers.get('location')?.split('/').pop();
		if (!id) {
			console.log(`✗ ${lab.path}: the profiler did not record (${rec.status})`);
			failed++;
			continue;
		}
		const page = await (await engine_of(lab.engine)).newPage({ viewport: { width: 1400, height: 900 } });
		// (a build measures only a browser that carries the profiler's key: the beacon's tag is added then)
		await page.setExtraHTTPHeaders(headers);
		// each visit the beacon sends, by size: the hide-time send rides keepalive (60 KB at most, the
		// beacon slims past it and the detail is lost) — the visits must stay well under
		page.on('request', (r) => {
			const d = r.method() === 'POST' && r.url().includes('/__profiler') ? (r.postData() ?? '') : '';
			if (d.includes('"visit"')) biggest = Math.max(biggest, d.length);
		});
		await page.goto(base + lab.path + (lab.query ?? ''), { waitUntil: 'load' });
		// (a click with the mouse, after the islands woke: the slowest interaction is the visit's)
		if (lab.click) {
			await page.waitForTimeout(1500);
			const b = await page.locator(lab.click).boundingBox();
			if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
		}
		if (lab.scroll) {
			await page.waitForTimeout(1200);
			await page.mouse.move(700, 450);
			for (let i = 0; i < 8; i++) {
				await page.mouse.wheel(0, 300);
				await page.waitForTimeout(150);
			}
		}
		// (a test browser closes without the page hiding: the beacon's resends must carry it all)
		await page.waitForTimeout(lab.stay);
		await page.close();
		await new Promise((r) => setTimeout(r, 2500));
		const report = await (await fetch(`${base}/__profiler/report/${id}.json`, { headers })).json();
		const findings = report.findings ?? [];
		const msg = (code) => findings.filter((f) => f.code === code).map((f) => f.message).join(' | ');
		const checks = [];
		for (const [code, said] of Object.entries(lab.named ?? {})) checks.push([`${code} says "${said}"`, msg(code).includes(said)]);
		for (const [code, not] of Object.entries(lab.never ?? {})) checks.push([`${code} never "${not}"`, !msg(code).includes(not)]);
		for (const code of lab.absent ?? []) checks.push([`no ${code}`, !findings.some((f) => f.code === code)]);
		const fix_of = (code) => findings.filter((f) => f.code === code).map((f) => f.fix ?? '').join(' | ');
		for (const [code, said] of Object.entries(lab.fix_says ?? {})) checks.push([`${code} fix says "${said}"`, fix_of(code).includes(said)]);
		for (const [code, not] of Object.entries(lab.fix_never ?? {})) checks.push([`${code} fix never "${not}"`, !fix_of(code).includes(not)]);
		const fix = (kind) => (report.patterns ?? []).filter((p) => p.kind === kind).map((p) => p.fix).join(' | ');
		for (const [kind, said] of Object.entries(lab.fixes ?? {})) checks.push([`${kind} fix says "${said}"`, fix(kind).includes(said)]);
		for (const [kind, not] of Object.entries(lab.fixes_never ?? {})) checks.push([`${kind} fix never "${not}"`, !!fix(kind) && !fix(kind).includes(not)]);
		const bad = checks.filter(([, ok]) => !ok);
		if (bad.length) failed++;
		console.log(`${bad.length ? '✗' : '✓'} ${lab.path}${lab.query ?? ''}${lab.engine ? ` (${lab.engine})` : ''}: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}`);
		for (const [n] of bad) {
			const code = n.split(' ')[0] === 'no' ? n.split(' ')[1] : n.split(' ')[0];
			console.log(`    ${code}: ${(msg(code) || fix(code)).slice(0, 300) || '(not in the report)'}${fix_of(code) ? `\n      fix: ${fix_of(code).slice(0, 300)}` : ''}`);
		}
	}
	// (the heaviest page of the playground too: its visit is the biggest one)
	{
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		await page.setExtraHTTPHeaders(headers);
		page.on('request', (r) => {
			const d = r.method() === 'POST' && r.url().includes('/__profiler') ? (r.postData() ?? '') : '';
			if (d.includes('"visit"')) biggest = Math.max(biggest, d.length);
		});
		await page.goto(base + '/hell', { waitUntil: 'load' });
		await page.waitForTimeout(4000);
		await page.close();
	}
	const ok = biggest > 0 && biggest <= VISIT_BUDGET;
	if (!ok) failed++;
	console.log(`${ok ? '✓' : '✗'} the biggest visit sent: ${(biggest / 1024).toFixed(1)} KB (under ${VISIT_BUDGET / 1000} KB: half of what a hide-time send may carry)`);
} finally {
	for (const b of Object.values(engines)) await b.close();
	stop();
}
console.log(failed ? `\n${failed} lab(s) failed` : '\nevery browser plant reached the report, the quiet pages quiet');
process.exit(failed ? 1 : 0);
