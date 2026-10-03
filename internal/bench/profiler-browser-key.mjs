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
const { chromium } = createRequire(new URL('../../package.json', import.meta.url))('playwright');

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
	{ path: '/dt-lcp', query: '?below', stay: 5000, named: { 'lcp-gap': 'Beside it, ' } },
	// (scrolled with the wheel after load: the beacon sends the jank again, the page never hides)
	// (a build's handler is a minified name in a hashed chunk: named by the island whose file it is)
	{ path: '/dt-jank', stay: 3000, scroll: true, named: { 'scroll-jank': "Janky's code, run by" }, never: { 'scroll-jank': 'Calm' } },
	// (the server's own answer: the page's Cache-Control, read off the profiled render)
	{ path: '/dt-nostore', stay: 1000, named: { 'bfcache-no-store': 'Cache-Control: no-store' } },
	// (the same page every render: "cache it", but a hook's cookie on the answer must be named first;
	// its control, the same page with no cookie, never — the pattern's fix, `fixes`, not a finding)
	{ path: '/dt-cookie', stay: 500, runs: 3, fixes: { 'same-document': 'sets a cookie (Set-Cookie)' } },
	{ path: '/dt-cookie-free', stay: 500, runs: 3, fixes: { 'same-document': 'Set Cache-Control with s-maxage' }, fixes_never: { 'same-document': 'Set-Cookie' } },
	// the quiet ones: none of the codes above
	{ path: '/dt-lab', stay: 2500, absent: ['font-invisible', 'image-oversized', 'images-eager-below', 'dom-large', 'preload-never-used', 'forced-layout', 'bfcache-no-store'] },
	{ path: '/dt-big', stay: 2000, absent: ['dom-large', 'image-oversized', 'forced-layout'] }
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
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		// (a build measures only a browser that carries the profiler's key: the beacon's tag is added then)
		await page.setExtraHTTPHeaders(headers);
		// each visit the beacon sends, by size: the hide-time send rides keepalive (60 KB at most, the
		// beacon slims past it and the detail is lost) — the visits must stay well under
		page.on('request', (r) => {
			const d = r.method() === 'POST' && r.url().includes('/__profiler') ? (r.postData() ?? '') : '';
			if (d.includes('"visit"')) biggest = Math.max(biggest, d.length);
		});
		await page.goto(base + lab.path + (lab.query ?? ''), { waitUntil: 'load' });
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
		const fix = (kind) => (report.patterns ?? []).filter((p) => p.kind === kind).map((p) => p.fix).join(' | ');
		for (const [kind, said] of Object.entries(lab.fixes ?? {})) checks.push([`${kind} fix says "${said}"`, fix(kind).includes(said)]);
		for (const [kind, not] of Object.entries(lab.fixes_never ?? {})) checks.push([`${kind} fix never "${not}"`, !!fix(kind) && !fix(kind).includes(not)]);
		const bad = checks.filter(([, ok]) => !ok);
		if (bad.length) failed++;
		console.log(`${bad.length ? '✗' : '✓'} ${lab.path}${lab.query ?? ''}: ${checks.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}`);
		for (const [n] of bad) {
			const code = n.split(' ')[0] === 'no' ? n.split(' ')[1] : n.split(' ')[0];
			console.log(`    ${code}: ${(msg(code) || fix(code)).slice(0, 300) || '(not in the report)'}`);
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
	await browser.close();
	stop();
}
console.log(failed ? `\n${failed} lab(s) failed` : '\nevery browser plant reached the report, the quiet pages quiet');
process.exit(failed ? 1 : 0);
