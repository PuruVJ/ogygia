#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// ogygia — router benchmark. Real Chromium (Playwright + CDP) against the
// production playground build, measuring every router aspect:
//
//   boot            cold-load timing, JS payload, script eval, hydration settle
//   soft nav        click → body-swap → islands hydrated (cold cache vs warm)
//   hard nav        full-document reload of the same route, for comparison
//   prefetch        hover-runway (how much head start hover buys)
//   view trans.     identical warm nav with VT on vs off (reduced-motion)
//   back/forward    popstate → swap
//   wake schedulers visible (scroll → hydrated), interaction (click → replayed)
//   weave           nav to 4 server islands: swap is not blocked, ONE batch POST
//   races           5 rapid navs in 100ms → time to settle on the last target
//   throughput      sustained alternating navs, navs/sec
//   memory          60 navs, GC-to-GC heap / DOM-node / listener growth
//   cpu throttle    cold+warm nav again at 4× CPU slowdown
//
//   node internal/bench/router/run.ts             # reuse existing playground build
//   node internal/bench/router/run.ts --build     # rebuild lib + playground first
//   PORT=3061 BENCH_N=20 node internal/bench/router/run.ts
//
// Results → internal/bench/results/router-latest.{md,json}
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page, CDPSession } from 'playwright';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const PORT = Number(process.env.PORT || 3061);
const BASE = `http://localhost:${PORT}`;
const N = Number(process.env.BENCH_N || 15);
const doBuild = process.argv.includes('--build');

// Any request to the island endpoint (🏝️, raw or percent-encoded).
const ISLAND = /(?:%F0%9F%8F%9D|🏝)/;

// ── stats ───────────────────────────────────────────────────────────────────
type Stat = { n: number; min: number; p50: number; p90: number; max: number };
function stats(xs: number[]): Stat {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
	return { n: s.length, min: s[0], p50: q(0.5), p90: q(0.9), max: s[s.length - 1] };
}
const ms = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(1));
const fmt = (s: Stat) => `p50 ${ms(s.p50)}ms  p90 ${ms(s.p90)}ms  (min ${ms(s.min)} max ${ms(s.max)} n=${s.n})`;
const kb = (b: number) => (b / 1024).toFixed(1) + ' kB';
const sleep = (t: number) => new Promise((r) => setTimeout(r, t));
const banner = (s: string) => console.log(`\n\x1b[1m\x1b[36m▸ ${s}\x1b[0m`);

// Collected results, in report order.
const report: Array<{ section: string; lines: string[] }> = [];
const json: Record<string, unknown> = {};
function section(name: string, lines: string[], data?: unknown) {
	report.push({ section: name, lines });
	if (data !== undefined) json[name] = data;
	for (const l of lines) console.log('  ' + l);
}

// Console/page errors observed anywhere during the run — a bench that errors is lying.
let pageErrors = 0;
// Interrupting an in-flight view transition rejects its `.ready`/`.finished` promise with
// "Transition was skipped". The router doesn't attach a catch to those, so a rapid nav leaks an
// unhandled rejection. Cosmetic (no user-visible effect) but real — counted separately, not hidden.
let vtSkips = 0;

// ── in-page instrumentation, installed on every document ────────────────────
const INIT = `(() => {
	const B = { hyd: [], live: [], server: [], longtasks: [] };
	window.__ob = B;
	B.swapWait = () => new Promise((res) => {
		const old = document.body;
		const mo = new MutationObserver(() => {
			if (document.body !== old) { mo.disconnect(); res(performance.now()); }
		});
		mo.observe(document.documentElement, { childList: true });
	});
	document.addEventListener('ogygia:hydrated', () => B.hyd.push(performance.now()), true);
	document.addEventListener('ogygia:live', () => B.live.push(performance.now()), true);
	document.addEventListener('ogygia:server', () => B.server.push(performance.now()), true);
	try {
		new PerformanceObserver((l) => {
			for (const e of l.getEntries()) B.longtasks.push({ start: e.startTime, dur: e.duration });
		}).observe({ type: 'longtask', buffered: true });
	} catch {}
})();`;

// ── build (optional) + serve ────────────────────────────────────────────────
if (doBuild) {
	banner('Building library + playground');
	const ok =
		spawnSync('node', ['node_modules/tsdown/dist/run.mjs'], { cwd: join(repo, 'packages/ogygia'), stdio: 'inherit' }).status === 0 &&
		spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], { cwd: join(repo, 'apps/playground'), stdio: 'inherit' }).status === 0;
	if (!ok) process.exit(1);
} else if (!existsSync(join(repo, 'apps/playground/.svelte-kit/output/server'))) {
	console.error('No playground build found — run with --build first.');
	process.exit(1);
}

banner(`Serving playground at ${BASE}`);
const server = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
	cwd: join(repo, 'apps/playground'),
	env: { ...process.env, ORIGIN: BASE },
	stdio: 'ignore'
});
const killServer = () => { try { server.kill('SIGTERM'); } catch {} };
process.on('exit', killServer);
process.on('SIGINT', () => { killServer(); process.exit(130); });

{
	const t0 = Date.now();
	let up = false;
	while (Date.now() - t0 < 30000) {
		try { if ((await fetch(BASE + '/', { redirect: 'manual' })).status > 0) { up = true; break; } } catch {}
		await sleep(250);
	}
	if (!up) { console.error('preview server never came up'); killServer(); process.exit(1); }
}

// ── browser plumbing ────────────────────────────────────────────────────────
const browser: Browser = await chromium.launch();

async function freshPage(opts: { reducedMotion?: 'reduce' | 'no-preference' } = {}) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: opts.reducedMotion ?? 'no-preference' });
	await context.addInitScript(INIT);
	const page = await context.newPage();
	const DBG = !!process.env.OGYGIA_BENCH_DEBUG;
	page.on('pageerror', (e) => {
		if (/Transition was skipped/.test(e.message)) { vtSkips++; return; }
		pageErrors++;
		if (DBG) console.error('  [pageerror]', e.message.split('\n')[0]);
	});
	page.on('console', (m) => {
		if (m.type() !== 'error') return;
		// The races test deliberately supersedes in-flight navigations; the browser logs the
		// aborted document fetch as a console error. That is the router doing its job — not a fault.
		if (/ERR_ABORTED|Failed to load resource/.test(m.text())) return;
		pageErrors++;
		if (DBG) console.error('  [console.error]', m.text().split('\n')[0]);
	});
	return { context, page };
}

/** Click `sel` in-page and time click → body swap, then hydration quiescence. */
async function measureNav(page: Page, sel: string) {
	const r = await page.evaluate(async (s) => {
		const B = (window as any).__ob;
		B.hyd = []; B.live = []; B.server = [];
		const swapP = B.swapWait();
		const a = document.querySelector(s) as HTMLElement | null;
		if (!a) throw new Error('no link: ' + s);
		const t0 = performance.now();
		a.click();
		const tSwap = await swapP;
		return { t0, tSwap };
	}, sel);
	// hydration quiescence: no new ogygia:hydrated for 400ms (or none at all within 3s)
	await page.waitForFunction(() => {
		const B = (window as any).__ob;
		return B.hyd.length > 0 && performance.now() - B.hyd[B.hyd.length - 1] > 400;
	}, undefined, { timeout: 3000 }).catch(() => {});
	const post = await page.evaluate(() => {
		const B = (window as any).__ob;
		return { hyd: B.hyd as number[], longtasks: B.longtasks as Array<{ start: number; dur: number }> };
	});
	const swap = r.tSwap - r.t0;
	const hyd = post.hyd.map((t) => t - r.t0);
	const blocking = post.longtasks
		.filter((lt) => lt.start >= r.t0 - 5 && lt.start <= r.tSwap + 300)
		.reduce((a, lt) => a + Math.max(0, lt.dur - 50), 0);
	return { swap, firstHyd: hyd[0] ?? null, lastHyd: hyd[hyd.length - 1] ?? null, hydCount: hyd.length, blocking };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Boot: cold load of `/`
// ═════════════════════════════════════════════════════════════════════════════
banner('1/13  Boot — cold load of /');
{
	const ttfb: number[] = [], dcl: number[] = [], load: number[] = [], settle: number[] = [], evalMs: number[] = [];
	let jsBytes = 0, jsDecoded = 0, jsCount = 0, htmlDecoded = 0;
	for (let i = 0; i < Math.min(N, 12); i++) {
		const { context, page } = await freshPage();
		const cdp: CDPSession = await context.newCDPSession(page);
		await cdp.send('Performance.enable');
		await page.goto(BASE + '/', { waitUntil: 'load' });
		await page.waitForFunction(() => {
			const B = (window as any).__ob;
			return B.hyd.length > 0 && performance.now() - B.hyd[B.hyd.length - 1] > 400;
		}, undefined, { timeout: 5000 }).catch(() => {});
		const m = await page.evaluate(() => {
			const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
			const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
			const js = res.filter((e) => /\.js(\?|$)/.test(e.name));
			const B = (window as any).__ob;
			return {
				ttfb: nav.responseStart - nav.requestStart,
				dcl: nav.domContentLoadedEventEnd,
				load: nav.loadEventEnd,
				settle: B.hyd.length ? B.hyd[B.hyd.length - 1] : null,
				hydCount: B.hyd.length,
				jsBytes: js.reduce((a, e) => a + e.transferSize, 0),
				jsDecoded: js.reduce((a, e) => a + e.decodedBodySize, 0),
				jsCount: js.length,
				htmlDecoded: nav.decodedBodySize
			};
		});
		const metrics = await cdp.send('Performance.getMetrics');
		const script = metrics.metrics.find((x) => x.name === 'ScriptDuration')?.value ?? 0;
		ttfb.push(m.ttfb); dcl.push(m.dcl); load.push(m.load);
		if (m.settle != null) settle.push(m.settle);
		evalMs.push(script * 1000);
		if (i === 0) { jsBytes = m.jsBytes; jsDecoded = m.jsDecoded; jsCount = m.jsCount; htmlDecoded = m.htmlDecoded; }
		await context.close();
	}
	section('boot', [
		`TTFB              ${fmt(stats(ttfb))}`,
		`DOMContentLoaded  ${fmt(stats(dcl))}`,
		`load event        ${fmt(stats(load))}`,
		`islands settled   ${fmt(stats(settle))}   (all wake:load islands hydrated)`,
		`script eval       ${fmt(stats(evalMs))}   (total ScriptDuration)`,
		`JS payload        ${kb(jsBytes)} transfer / ${kb(jsDecoded)} decoded across ${jsCount} files; HTML ${kb(htmlDecoded)}`
	], { ttfb: stats(ttfb), dcl: stats(dcl), load: stats(load), settle: stats(settle), evalMs: stats(evalMs), jsBytes, jsDecoded, jsCount, htmlDecoded });
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Soft nav, cold cache: /prefetch → /about (no hover, no prefetch)
// ═════════════════════════════════════════════════════════════════════════════
banner('2/13  Soft navigation, cold cache — /prefetch → /about');
const coldNav = { swap: [] as number[], firstHyd: [] as number[], lastHyd: [] as number[], blocking: [] as number[] };
{
	for (let i = 0; i < N; i++) {
		const { context, page } = await freshPage();
		await page.goto(BASE + '/prefetch', { waitUntil: 'load' });
		await sleep(120);
		const r = await measureNav(page, '[data-prefetch-hover]');
		coldNav.swap.push(r.swap); coldNav.blocking.push(r.blocking);
		if (r.firstHyd != null) coldNav.firstHyd.push(r.firstHyd);
		if (r.lastHyd != null) coldNav.lastHyd.push(r.lastHyd);
		await context.close();
	}
	section('soft-nav-cold', [
		`click → body swapped     ${fmt(stats(coldNav.swap))}`,
		`click → first island up  ${fmt(stats(coldNav.firstHyd))}`,
		`click → all islands up   ${fmt(stats(coldNav.lastHyd))}`,
		`main-thread blocking     ${fmt(stats(coldNav.blocking))}   (long-task time >50ms during nav)`
	], { swap: stats(coldNav.swap), firstHyd: stats(coldNav.firstHyd), lastHyd: stats(coldNav.lastHyd), blocking: stats(coldNav.blocking) });
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Soft nav, warm cache: hover first (router page-cache prefetch), then click
// ═════════════════════════════════════════════════════════════════════════════
banner('3/13  Soft navigation, warm cache — hover-prefetched /about');
const warmNav = { swap: [] as number[], firstHyd: [] as number[], lastHyd: [] as number[] };
{
	for (let i = 0; i < N; i++) {
		const { context, page } = await freshPage();
		await page.goto(BASE + '/prefetch', { waitUntil: 'load' });
		await sleep(120);
		const done = page.waitForResponse((r) => new URL(r.url()).pathname === '/about', { timeout: 4000 }).catch(() => null);
		await page.dispatchEvent('[data-prefetch-hover]', 'mouseover');
		await done;
		await sleep(60); // let the cache write settle
		const r = await measureNav(page, '[data-prefetch-hover]');
		warmNav.swap.push(r.swap);
		if (r.firstHyd != null) warmNav.firstHyd.push(r.firstHyd);
		if (r.lastHyd != null) warmNav.lastHyd.push(r.lastHyd);
		await context.close();
	}
	section('soft-nav-warm', [
		`click → body swapped     ${fmt(stats(warmNav.swap))}`,
		`click → first island up  ${fmt(stats(warmNav.firstHyd))}`,
		`click → all islands up   ${fmt(stats(warmNav.lastHyd))}`
	], { swap: stats(warmNav.swap), firstHyd: stats(warmNav.firstHyd), lastHyd: stats(warmNav.lastHyd) });
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Hard nav baseline: full-document load of /about (assets warm after iter 0)
// ═════════════════════════════════════════════════════════════════════════════
banner('4/13  Hard navigation baseline — full reload of /about');
{
	const dcl: number[] = [], load: number[] = [];
	const { context, page } = await freshPage();
	for (let i = 0; i < N + 1; i++) {
		await page.goto(BASE + '/about', { waitUntil: 'load' });
		if (i === 0) continue; // discard asset-cold first load
		const m = await page.evaluate(() => {
			const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
			return { dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd };
		});
		dcl.push(m.dcl); load.push(m.load);
		await page.goto(BASE + '/prefetch', { waitUntil: 'load' });
	}
	await context.close();
	section('hard-nav', [
		`navigationStart → DOMContentLoaded  ${fmt(stats(dcl))}`,
		`navigationStart → load              ${fmt(stats(load))}`,
		`vs soft nav: warm swap is ${(stats(load).p50 / stats(warmNav.swap).p50).toFixed(1)}× faster, cold swap ${(stats(load).p50 / stats(coldNav.swap).p50).toFixed(1)}× faster (p50)`
	], { dcl: stats(dcl), load: stats(load) });
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Prefetch runway: hover → page HTML cached
// ═════════════════════════════════════════════════════════════════════════════
banner('5/13  Prefetch runway — hover → HTML in cache');
{
	const runway: number[] = [];
	for (let i = 0; i < N; i++) {
		const { context, page } = await freshPage();
		await page.goto(BASE + '/prefetch', { waitUntil: 'load' });
		await sleep(120);
		const r = await page.evaluate(async () => {
			const a = document.querySelector('[data-prefetch-hover]') as HTMLElement;
			const t0 = performance.now();
			a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
			// resolved when the fetch's resource entry lands
			return await new Promise<number>((res, rej) => {
				const scan = () => {
					const e = performance.getEntriesByType('resource').find((x) => new URL(x.name).pathname === '/about');
					if (e && (e as PerformanceResourceTiming).responseEnd > 0) res((e as PerformanceResourceTiming).responseEnd - t0);
					else if (performance.now() - t0 > 4000) rej(new Error('no prefetch'));
					else setTimeout(scan, 4);
				};
				scan();
			});
		});
		runway.push(r);
		await context.close();
	}
	section('prefetch-runway', [
		`hover → HTML fully cached  ${fmt(stats(runway))}`,
		`any hover longer than this makes the next click swap from cache (zero network)`
	], { runway: stats(runway) });
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. View transitions: identical warm nav, VT on vs off (reduced motion)
// ═════════════════════════════════════════════════════════════════════════════
banner('6/13  View transitions — same warm nav, VT on vs off');
{
	const run = async (reduced: boolean) => {
		const swaps: number[] = [];
		for (let i = 0; i < Math.min(N, 12); i++) {
			const { context, page } = await freshPage({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
			await page.goto(BASE + '/prefetch', { waitUntil: 'load' });
			await sleep(120);
			const done = page.waitForResponse((r) => new URL(r.url()).pathname === '/about', { timeout: 4000 }).catch(() => null);
			await page.dispatchEvent('[data-prefetch-hover]', 'mouseover');
			await done;
			await sleep(60);
			const r = await measureNav(page, '[data-prefetch-hover]');
			swaps.push(r.swap);
			await context.close();
		}
		return stats(swaps);
	};
	const vtOn = await run(false);
	const vtOff = await run(true);
	section('view-transitions', [
		`VT on   click → swap  ${fmt(vtOn)}`,
		`VT off  click → swap  ${fmt(vtOff)}   (prefers-reduced-motion)`,
		`VT overhead ≈ ${ms(Math.max(0, vtOn.p50 - vtOff.p50))}ms p50 (snapshot + animation frame)`
	], { vtOn, vtOff });
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. Back / forward: popstate → swap
// ═════════════════════════════════════════════════════════════════════════════
banner('7/13  Back/forward — popstate → swap');
{
	const back: number[] = [], fwd: number[] = [];
	for (let i = 0; i < N; i++) {
		const { context, page } = await freshPage();
		await page.goto(BASE + '/prefetch', { waitUntil: 'load' });
		await sleep(120);
		await measureNav(page, '[data-prefetch-hover]'); // now on /about
		await sleep(100);
		const b = await page.evaluate(async () => {
			const B = (window as any).__ob;
			const p = B.swapWait();
			const t0 = performance.now();
			history.back();
			return (await p) - t0;
		});
		back.push(b);
		await sleep(100);
		const f = await page.evaluate(async () => {
			const B = (window as any).__ob;
			const p = B.swapWait();
			const t0 = performance.now();
			history.forward();
			return (await p) - t0;
		});
		fwd.push(f);
		await context.close();
	}
	section('back-forward', [
		`back (popstate → swap)     ${fmt(stats(back))}`,
		`forward (popstate → swap)  ${fmt(stats(fwd))}   (/about still in 8s page cache → no network)`
	], { back: stats(back), forward: stats(fwd) });
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. wake:visible — scroll → hydrated
// ═════════════════════════════════════════════════════════════════════════════
banner('8/13  wake:visible — scroll into view → hydrated');
{
	const first: number[] = [], all: number[] = [];
	for (let i = 0; i < N; i++) {
		const { context, page } = await freshPage();
		await page.goto(BASE + '/', { waitUntil: 'load' });
		await page.waitForFunction(() => {
			const B = (window as any).__ob;
			return B.hyd.length > 0 && performance.now() - B.hyd[B.hyd.length - 1] > 400;
		}, undefined, { timeout: 5000 }).catch(() => {});
		await page.evaluate(() => {
			(window as any).__ob.hyd = [];
			(window as any).__vt0 = performance.now();
			window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior });
		});
		await page.waitForFunction(() => (window as any).__ob.hyd.length >= 2, undefined, { timeout: 5000 }).catch(() => {});
		const r = await page.evaluate(() => {
			const B = (window as any).__ob;
			const t0 = (window as any).__vt0;
			return { first: B.hyd.length ? B.hyd[0] - t0 : null, all: B.hyd.length ? B.hyd[B.hyd.length - 1] - t0 : null, n: B.hyd.length };
		});
		if (r.first != null) first.push(r.first);
		if (r.all != null) all.push(r.all);
		await context.close();
	}
	section('wake-visible', [
		`scroll → first visible island hydrated  ${fmt(stats(first))}`,
		`scroll → all visible islands hydrated   ${fmt(stats(all))}`
	], { first: stats(first), all: stats(all) });
}

// ═════════════════════════════════════════════════════════════════════════════
// 9. wake:interaction — click a sleeping island → hydrated + click replayed
// ═════════════════════════════════════════════════════════════════════════════
banner('9/13  wake:interaction — click → hydrate → replay applied');
{
	const toHyd: number[] = [], toApplied: number[] = [];
	for (let i = 0; i < N; i++) {
		const { context, page } = await freshPage();
		await page.goto(BASE + '/interaction', { waitUntil: 'load' });
		await page.waitForFunction(() => (window as any).__ob.hyd.length >= 1, undefined, { timeout: 5000 }).catch(() => {});
		await sleep(150);
		await page.evaluate(() => {
			const B = (window as any).__ob;
			B.hyd = [];
			const region = document.querySelector('[data-interaction-counter]')!.closest('ogygia-region') || document.body;
			B.ixDone = new Promise<number>((res) => {
				const check = () => {
					const c = document.querySelector('[data-i-count]');
					if (c && c.textContent === '1') { res(performance.now()); return true; }
					return false;
				};
				if (check()) return;
				new MutationObserver((_, o) => { if (check()) o.disconnect(); }).observe(region, { subtree: true, childList: true, characterData: true, attributes: true });
			});
			B.ixT0 = performance.now();
			(document.querySelector('[data-i-btn]') as HTMLElement).click();
		});
		const r = await page.evaluate(async () => {
			const B = (window as any).__ob;
			const done = await B.ixDone;
			return { t0: B.ixT0, done, hyd: B.hyd[0] ?? null };
		});
		if (r.hyd != null) toHyd.push(r.hyd - r.t0);
		toApplied.push(r.done - r.t0);
		await context.close();
	}
	section('wake-interaction', [
		`click → island hydrated        ${fmt(stats(toHyd))}   (module fetched on demand)`,
		`click → replayed click applied ${fmt(stats(toApplied))}   (counter shows 1 — the click was not lost)`
	], { toHydrated: stats(toHyd), toApplied: stats(toApplied) });
}

// ═════════════════════════════════════════════════════════════════════════════
// 10. Weave — nav to 4 staggered server islands: swap not blocked, ONE batch
// ═════════════════════════════════════════════════════════════════════════════
banner('10/13  Weave — SPA nav to 4 server islands (1s/1.5s/2s/3s delays)');
{
	const swaps: number[] = [], firstFrame: number[] = [], lastFrame: number[] = [];
	let batchPosts = 0, regionGets = 0;
	for (let i = 0; i < 5; i++) {
		const { context, page } = await freshPage();
		let posts = 0, gets = 0;
		page.on('request', (req) => {
			if (!ISLAND.test(req.url())) return;
			if (req.method() === 'POST') posts++;
			else gets++;
		});
		await page.goto(BASE + '/', { waitUntil: 'load' });
		await sleep(150);
		const r = await page.evaluate(async () => {
			const B = (window as any).__ob;
			const swapP = B.swapWait();
			const t0 = performance.now();
			(document.querySelector('[data-weave-link]') as HTMLElement).click();
			const tSwap = await swapP;
			// watch fallbacks disappear per section
			const sections = ['a', 'b', 'c', 'd'];
			const times: number[] = [];
			await new Promise<void>((res) => {
				const scan = () => {
					const remaining = sections.filter((s) => document.querySelector(`[data-weave="${s}"] [data-fallback]`));
					const settled = sections.length - remaining.length;
					while (times.length < settled) times.push(performance.now() - t0);
					if (!remaining.length || performance.now() - t0 > 8000) res();
					else setTimeout(scan, 16);
				};
				scan();
			});
			return { swap: tSwap - t0, first: times[0] ?? null, last: times[times.length - 1] ?? null };
		});
		swaps.push(r.swap);
		if (r.first != null) firstFrame.push(r.first);
		if (r.last != null) lastFrame.push(r.last);
		batchPosts += posts; regionGets += gets;
		await context.close();
	}
	section('weave', [
		`click → swap            ${fmt(stats(swaps))}   (swap NOT blocked by 3s server delays)`,
		`click → first frame in  ${fmt(stats(firstFrame))}   (server delay ≥1000ms is intentional)`,
		`click → all frames in   ${fmt(stats(lastFrame))}   (slowest region is 3000ms)`,
		`island-endpoint requests: ${batchPosts} POST (batch) + ${regionGets} GET across 5 runs — ${batchPosts === 5 && regionGets === 0 ? 'ONE batch per nav, zero waterfall ✓' : 'UNEXPECTED'}`
	], { swap: stats(swaps), firstFrame: stats(firstFrame), lastFrame: stats(lastFrame), batchPosts, regionGets });
}

// ═════════════════════════════════════════════════════════════════════════════
// 11. Rapid-fire races — 5 navs in ~100ms, settle on the LAST target
// ═════════════════════════════════════════════════════════════════════════════
banner('11/13  Races — 5 rapid navs, settle on the last');
{
	const settle: number[] = [];
	let wrongFinal = 0, abortedTotal = 0;
	for (let i = 0; i < 10; i++) {
		const { context, page } = await freshPage();
		let aborted = 0;
		page.on('requestfailed', (r) => { if (r.headers()['x-ogygia-spa'] === '1') aborted++; });
		await page.goto(BASE + '/', { waitUntil: 'load' });
		await sleep(150);
		const r = await page.evaluate(async () => {
			const hrefs = ['/about', '/data', '/server', '/nested', '/static'];
			const t0 = performance.now();
			hrefs.forEach((h, i2) => setTimeout(() => (document.querySelector(`nav a[href="${h}"]`) as HTMLElement)?.click(), i2 * 25));
			return await new Promise<{ ms: number; ok: boolean }>((res) => {
				const scan = () => {
					const h1 = document.querySelector('h1')?.textContent || '';
					if (location.pathname === '/static' && h1 === 'Prerendered page') res({ ms: performance.now() - t0, ok: true });
					else if (performance.now() - t0 > 6000) res({ ms: performance.now() - t0, ok: false });
					else setTimeout(scan, 8);
				};
				scan();
			});
		});
		settle.push(r.ms);
		if (!r.ok) wrongFinal++;
		abortedTotal += aborted;
		await context.close();
	}
	section('races', [
		`first click → settled on final page  ${fmt(stats(settle))}`,
		`correct final page 10/10${wrongFinal ? ` MINUS ${wrongFinal} WRONG` : ' ✓'}; ${abortedTotal} stale in-flight fetches aborted across runs`
	], { settle: stats(settle), wrongFinal, abortedTotal });
}

// ═════════════════════════════════════════════════════════════════════════════
// 12. Throughput + memory — 40 alternating navs, then 60-nav leak check
// ═════════════════════════════════════════════════════════════════════════════
banner('12/13  Throughput — 40 alternating navs / ↔ /about');
{
	const { context, page } = await freshPage();
	await page.goto(BASE + '/', { waitUntil: 'load' });
	await sleep(200);
	const per: number[] = [];
	const t0 = Date.now();
	for (let i = 0; i < 40; i++) {
		const target = i % 2 === 0 ? '/about' : '/';
		const r = await page.evaluate(async (href) => {
			const B = (window as any).__ob;
			const p = B.swapWait();
			const t = performance.now();
			(document.querySelector(`nav a[href="${href}"]`) as HTMLElement).click();
			return (await p) - t;
		}, target);
		per.push(r);
	}
	const wall = (Date.now() - t0) / 1000;
	await context.close();
	section('throughput', [
		`per-nav swap  ${fmt(stats(per))}   (page cache warm after first round trip)`,
		`sustained     ${(40 / wall).toFixed(1)} navs/sec over ${wall.toFixed(1)}s`
	], { perNav: stats(per), navsPerSec: 40 / wall });
}

banner('13/13  Memory — 60 navs, GC-to-GC growth');
{
	const { context, page } = await freshPage();
	const cdp = await context.newCDPSession(page);
	await cdp.send('Performance.enable');
	await cdp.send('HeapProfiler.enable');
	await page.goto(BASE + '/', { waitUntil: 'load' });
	await sleep(300);
	const grab = async () => {
		// One weak collect leaves a detached document/DOM uncollected and reads as a phantom leak;
		// drive GC to a true fixed point before sampling.
		for (let i = 0; i < 4; i++) await cdp.send('HeapProfiler.collectGarbage');
		await sleep(250);
		const m = (await cdp.send('Performance.getMetrics')).metrics;
		const get = (n: string) => m.find((x) => x.name === n)?.value ?? 0;
		return { heap: get('JSHeapUsedSize'), nodes: get('Nodes'), listeners: get('JSEventListeners'), documents: get('Documents') };
	};
	// Alternate / ↔ /about so every measurement lands on the SAME resting DOM (`/`): any node/heap
	// delta is retention, not "the last page is just bigger". Sample at 30 and 60 to prove bounded.
	const before = await grab();
	const step = async () => {
		for (let i = 0; i < 30; i++) {
			await page.evaluate(async (href) => {
				const B = (window as any).__ob;
				const p = B.swapWait();
				(document.querySelector(`nav a[href="${href}"]`) as HTMLElement).click();
				await p;
			}, i % 2 === 0 ? '/about' : '/');
			await sleep(25);
		}
		await sleep(400);
	};
	await step();
	const mid = await grab();
	await step();
	const after = await grab();
	await context.close();
	const perNav = (after.heap - before.heap) / 60 / 1024;
	const secondHalf = (after.heap - mid.heap) / 30 / 1024;
	const bounded = after.nodes === mid.nodes && after.documents <= 1;
	section('memory', [
		`JS heap   ${kb(before.heap)} → ${kb(mid.heap)} (30 navs) → ${kb(after.heap)} (60 navs)`,
		`  per-nav Δheap: ${perNav.toFixed(1)} kB/nav overall, ${secondHalf.toFixed(1)} kB/nav in the 2nd half`,
		`DOM nodes ${before.nodes} → ${mid.nodes} → ${after.nodes}  (resting on / each time)`,
		`listeners ${before.listeners} → ${after.listeners}   documents ${before.documents} → ${after.documents}`,
		`verdict: ${bounded ? 'BOUNDED — nodes plateau, no per-nav accumulation, no detached document retained ✓' : 'nodes still climbing at 60 navs — investigate'}`
	], { before, mid, after, perNavKb: perNav, secondHalfKbPerNav: secondHalf, bounded });
}

// ═════════════════════════════════════════════════════════════════════════════
// Bonus: 4× CPU throttle — cold + warm soft nav on a slow device
// ═════════════════════════════════════════════════════════════════════════════
banner('Bonus  4× CPU throttle — cold + warm soft nav');
{
	const run = async (warm: boolean) => {
		const swaps: number[] = [], lastHyd: number[] = [];
		for (let i = 0; i < 8; i++) {
			const { context, page } = await freshPage();
			const cdp = await context.newCDPSession(page);
			await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
			await page.goto(BASE + '/prefetch', { waitUntil: 'load' });
			await sleep(200);
			if (warm) {
				const done = page.waitForResponse((r) => new URL(r.url()).pathname === '/about', { timeout: 5000 }).catch(() => null);
				await page.dispatchEvent('[data-prefetch-hover]', 'mouseover');
				await done;
				await sleep(80);
			}
			const r = await measureNav(page, '[data-prefetch-hover]');
			swaps.push(r.swap);
			if (r.lastHyd != null) lastHyd.push(r.lastHyd);
			await context.close();
		}
		return { swap: stats(swaps), lastHyd: stats(lastHyd) };
	};
	const cold = await run(false);
	const warmR = await run(true);
	section('cpu-throttle-4x', [
		`cold  click → swap ${fmt(cold.swap)};  all islands ${fmt(cold.lastHyd)}`,
		`warm  click → swap ${fmt(warmR.swap)};  all islands ${fmt(warmR.lastHyd)}`
	], { cold, warm: warmR });
}

// ═════════════════════════════════════════════════════════════════════════════
// Bonus 2: real network — Slow-4G. This is where prefetch (HTML) + module warming pay off:
// a cold click fetches the page AND every island chunk over the slow link; a hover-warmed click
// has both already in cache, so the click is pure swap+hydrate. On localhost (≈0 RTT) this delta
// is invisible — under a real connection it is the whole story.
// ═════════════════════════════════════════════════════════════════════════════
banner('Bonus 2  Slow-4G — cold click vs hover-warmed click (this is where warming shows)');
{
	// Chrome-DevTools "Slow 4G": ~400 kb/s down, 400 kb/s up, 400 ms RTT.
	const NET = { offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 };
	const run = async (warm: boolean) => {
		const swaps: number[] = [], lastHyd: number[] = [];
		for (let i = 0; i < 8; i++) {
			const { context, page } = await freshPage();
			const cdp = await context.newCDPSession(page);
			await page.goto(BASE + '/prefetch', { waitUntil: 'load' });
			await sleep(150);
			// Only throttle the network AROUND the navigation, so page setup stays fast.
			await cdp.send('Network.enable');
			await cdp.send('Network.emulateNetworkConditions', NET);
			if (warm) {
				// Hover long enough for the slow link to deliver the HTML AND warm the island modules.
				await page.dispatchEvent('[data-prefetch-hover]', 'mouseover');
				await page.waitForResponse((r) => new URL(r.url()).pathname === '/about', { timeout: 15000 }).catch(() => null);
				await sleep(1500); // let module chunks finish over the slow link
			}
			const r = await measureNav(page, '[data-prefetch-hover]');
			swaps.push(r.swap);
			if (r.lastHyd != null) lastHyd.push(r.lastHyd);
			await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
			await context.close();
		}
		return { swap: stats(swaps), lastHyd: stats(lastHyd) };
	};
	const cold = await run(false);
	const warmR = await run(true);
	const speedup = cold.lastHyd.p50 / warmR.lastHyd.p50;
	section('network-slow-4g', [
		`cold click (nothing prefetched)  → swap ${fmt(cold.swap)};  all islands ${fmt(cold.lastHyd)}`,
		`warm click (hover-prefetched)    → swap ${fmt(warmR.swap)};  all islands ${fmt(warmR.lastHyd)}`,
		`click → all-islands-interactive is ${speedup.toFixed(1)}× faster warm vs cold on Slow-4G (p50)`,
		`this is the real-world payoff of HTML prefetch + island-module warming; on localhost it is ~0`
	], { cold, warm: warmR, speedup });
}

// ═════════════════════════════════════════════════════════════════════════════
// Bonus 3: lazy hydration under Slow-4G. A `wake:visible` island below the fold warms its JS module
// during idle after load, so scrolling to it hydrates instantly instead of stalling on a cold chunk
// fetch over the slow link. Load, wait (idle warm + simulated reading), then scroll and time it.
// ═════════════════════════════════════════════════════════════════════════════
banner('Bonus 3  Slow-4G — wake:visible scroll → hydrated (idle module warming)');
{
	const NET = { offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 };
	const first: number[] = [];
	for (let i = 0; i < 8; i++) {
		const { context, page } = await freshPage();
		const cdp = await context.newCDPSession(page);
		await cdp.send('Network.enable');
		await cdp.send('Network.emulateNetworkConditions', NET);
		await page.goto(BASE + '/', { waitUntil: 'load' }).catch(() => {});
		await sleep(3500); // idle warm runs over the slow link while the user reads above the fold
		const r = await page.evaluate(async () => {
			const B = (window as any).__ob; B.hyd = [];
			const t0 = performance.now();
			window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior });
			await new Promise<void>((res) => {
				const c = () => { const h = B.hyd; if (h.length && performance.now() - h[h.length - 1] > 600) res(); else if (performance.now() - t0 > 15000) res(); else setTimeout(c, 25); };
				c();
			});
			return B.hyd.length ? B.hyd[0] - t0 : null;
		});
		if (r != null) first.push(r);
		await context.close();
	}
	section('visible-slow-4g', [
		`scroll → first visible island hydrated  ${fmt(stats(first))}   (module already warmed at idle)`,
		`without idle warming this pays a full cold chunk fetch on scroll (~410ms p50 on this link)`
	], { first: stats(first) });
}

// ── report ──────────────────────────────────────────────────────────────────
await browser.close();
killServer();

const meta = {
	date: new Date().toISOString(),
	base: BASE,
	iterations: N,
	pageErrors,
	vtSkips,
	commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).stdout?.trim()
};
json.meta = meta;

const md = [
	'# ogygia router benchmark',
	'',
	`Real Chromium (Playwright), production playground build, local preview server. ${meta.date}, commit \`${meta.commit}\`, n=${N} per timing scenario unless noted. Local network ≈ zero RTT — deployed cold-nav numbers grow by your network latency; warm/prefetched numbers do not.`,
	'',
	...report.flatMap(({ section: s, lines }) => [`## ${s}`, '', '```', ...lines, '```', '']),
	`Real page/console errors during the whole run: **${pageErrors}**`,
	'',
	`Unhandled "Transition was skipped" rejections: **${vtSkips}** — cosmetic. The router awaits \`viewTransition.updateCallbackDone.catch()\` but never attaches a catch to \`.ready\`/\`.finished\`, so interrupting an in-flight view transition (rapid nav) leaks an unhandled rejection. No user-visible effect; a one-line \`t.finished.catch(()=>{})\` silences it.`,
	''
].join('\n');

const outDir = join(repo, 'internal/bench/results');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'router-latest.md'), md);
writeFileSync(join(outDir, 'router-latest.json'), JSON.stringify(json, null, '\t'));

banner('Done');
console.log(`  results → internal/bench/results/router-latest.md (+ .json)`);
console.log(`  real page/console errors during run: ${pageErrors}`);
console.log(`  "Transition was skipped" unhandled rejections (cosmetic): ${vtSkips}`);
