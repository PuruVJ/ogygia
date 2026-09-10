// CLIENT-BOOT BENCH: what the runtime costs the main thread on a large CMS page shape.
// Serves a BUILT playground (`vite preview` of the given app dir) and loads /bench-cms in Chromium
// under a 4× CPU throttle: long tasks after DOMContentLoaded (count, total blocking = Σ(dur − 50)),
// time until every `wake:'load'` island is hydrated, the seed/props bytes left in the DOM, and the
// first-party JS self time from a sampling profile. Median of N runs.
// Usage: node internal/bench/client-boot.mjs [app_dir=apps/playground] [runs=3] [port=4180]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [app_arg = 'apps/playground', runs_s = '3', port_s = '4180'] = process.argv.slice(2);
const RUNS = Number(runs_s);
const PORT = Number(port_s);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = path.resolve(root, app_arg);
const vite_bin = path.join(app, 'node_modules/vite/bin/vite.js');
const server = spawn(process.execPath, [vite_bin, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
	cwd: app,
	env: { ...process.env, ORIGIN: `http://127.0.0.1:${PORT}` },
	stdio: ['ignore', 'pipe', 'pipe']
});
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) {
	try { await fetch(base + '/bench-cms'); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
	if (i === 99) { console.error('server never came up'); process.exit(1); }
}

const browser = await chromium.launch({ channel: 'chromium' });
async function run() {
	const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true });
	const page = await ctx.newPage();
	const cdp = await ctx.newCDPSession(page);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
	await page.addInitScript(() => {
		window.__t = { long: [], dcl: 0, hydrated_all: 0 };
		new PerformanceObserver((l) => {
			for (const e of l.getEntries()) window.__t.long.push([Math.round(e.startTime), Math.round(e.duration)]);
		}).observe({ type: 'longtask', buffered: true });
		document.addEventListener('DOMContentLoaded', () => (window.__t.dcl = Math.round(performance.now())));
	});
	await cdp.send('Profiler.enable');
	await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
	await cdp.send('Profiler.start');
	await page.goto(base + '/bench-cms', { waitUntil: 'load' });
	// every load island hydrated (the visible ones are in the viewport too on this page shape)
	await page.waitForFunction(
		() => {
			const all = [...document.querySelectorAll('ogygia-region[wake="load"]')];
			return all.length > 0 && all.every((r) => r.hasAttribute('data-hydrated'));
		},
		null,
		{ timeout: 60_000 }
	);
	const hydrated_all = await page.evaluate(() => Math.round(performance.now()));
	await page.waitForTimeout(1500);
	const { profile } = await cdp.send('Profiler.stop');
	const r = await page.evaluate(() => {
		const t = window.__t;
		const after_dcl = t.long.filter(([s]) => s >= t.dcl);
		return {
			dcl: t.dcl,
			long_tasks: after_dcl.length,
			longest: Math.max(0, ...after_dcl.map(([, d]) => d)),
			blocking: after_dcl.reduce((a, [, d]) => a + Math.max(0, d - 50), 0),
			seed_bytes_left: [...document.querySelectorAll('script[type="application/ogygia-page"]')].reduce((a, e) => a + e.textContent.length, 0),
			props_bytes_left: [...document.querySelectorAll('script[type="application/ogygia-props"]')].reduce((a, e) => a + e.textContent.length, 0),
			regions: document.querySelectorAll('ogygia-region').length,
			hydrated: document.querySelectorAll('ogygia-region[data-hydrated]').length,
			boot_scripts: [...document.querySelectorAll('script[type=module][src]')].length
		};
	});
	const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
	const hits = new Map();
	for (let i = 0; i < profile.samples.length; i++) hits.set(profile.samples[i], (hits.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
	let runtime = 0, chunks = 0;
	for (const [id, us] of hits) {
		const u = nodes.get(id).callFrame.url || '';
		if (!u.includes(`:${PORT}/`)) continue;
		if (/og-runtime|runtime/.test(u)) runtime += us; else chunks += us;
	}
	await ctx.close();
	return { ...r, hydrated_all, runtime_ms: Math.round(runtime / 1000), chunks_ms: Math.round(chunks / 1000) };
}
const results = [];
for (let i = 0; i < RUNS; i++) results.push(await run());
await browser.close();
server.kill('SIGINT');
const med = (k) => { const s = results.map((r) => r[k]).sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
console.log(`client-boot · ${app_arg} · /bench-cms · 4× CPU throttle · median of ${RUNS}`);
console.log(`  regions ${med('regions')} · hydrated ${med('hydrated')} · DCL ${med('dcl')} ms · all load islands hydrated at ${med('hydrated_all')} ms`);
console.log(`  long tasks after DCL: ${med('long_tasks')} · longest ${med('longest')} ms · blocking Σ(dur−50) ${med('blocking')} ms`);
console.log(`  JS self time: ogygia runtime ${med('runtime_ms')} ms · island/app chunks ${med('chunks_ms')} ms · module scripts at boot ${med('boot_scripts')}`);
console.log(`  bytes left in the DOM: seed ${med('seed_bytes_left')} · props ${med('props_bytes_left')}`);
