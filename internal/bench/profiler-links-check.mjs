// EVERY "SHOW THE ROW" LINK IN A REPORT OPENS A ROW. A report links from its findings, slow
// patterns, exact lines, paths, spans, memo candidates and deopts to rows of its tables
// (`#fn=<key>`, `#comp=<name>`, `#island=<name>`, `#seed=<key>`). A link whose row is not there does
// nothing when clicked: on a heavy page 43 of 67 once did (the functions table kept only its top 80;
// the islands table opened by fingerprint while links named the component). This profiles pages with
// many links, clicks each one, and checks that a row with that id exists and is open. It also checks
// that no id appears twice.
//
//   node internal/bench/profiler-links-check.mjs http://127.0.0.1:4196 <profiler key>
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:4196';
const secret = process.argv[3] ?? 'hell';
const H = { 'x-profiler-key': secret };
const PAGES = ['/hell', '/hell-fixed', '/inferno', '/heavy', '/mixed', '/context'];

async function profile(path) {
	for (let i = 0; i < 20; i++) {
		const r = await fetch(`${base}/__profiler/page?p=${encodeURIComponent(path)}&runs=1`, { headers: H, redirect: 'manual' });
		const loc = r.headers.get('location');
		if (loc) return loc.split('/').pop();
		if (r.status !== 409) return null;
		await new Promise((ok) => setTimeout(ok, 1500));
	}
	return null;
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ extraHTTPHeaders: H, viewport: { width: 1400, height: 900 } })).newPage();
let failed = 0;
try {
	for (const path of PAGES) {
		const id = await profile(path);
		if (!id) {
			console.log(`✗ ${path}: no report`);
			failed++;
			continue;
		}
		await page.goto(`${base}/__profiler/report/${id}`, { waitUntil: 'load' });
		await page.waitForTimeout(800);
		const { hrefs, dup } = await page.evaluate(() => {
			const n = new Map();
			for (const e of document.querySelectorAll('[id]')) n.set(e.id, (n.get(e.id) ?? 0) + 1);
			return {
				hrefs: [...new Set([...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')).filter((h) => /^#(comp|fn|island|seed)=/.test(h)))],
				dup: [...n].filter(([, c]) => c > 1).map(([k, c]) => `${k}×${c}`)
			};
		});
		const dead = [];
		for (const h of hrefs) {
			const ok = await page.evaluate(async (h) => {
				// the same id the tables use (row-anchor.svelte.ts)
				const rid = (kind, key) => {
					let x = 5381;
					for (let i = 0; i < key.length; i++) x = (Math.imul(x, 33) ^ key.charCodeAt(i)) >>> 0;
					return `row-${kind}-${x.toString(36)}`;
				};
				location.hash = '#-';
				await new Promise((ok) => setTimeout(ok, 30));
				location.hash = h;
				await new Promise((ok) => setTimeout(ok, 150));
				const kind = h.slice(1, h.indexOf('='));
				const el = document.getElementById(rid(kind, decodeURIComponent(h.slice(h.indexOf('=') + 1))));
				return !!el && (el.classList.contains('open') || el.classList.contains('picked'));
			}, h);
			if (!ok) dead.push(decodeURIComponent(h));
		}
		const bad = dead.length || dup.length;
		if (bad) failed++;
		console.log(`${bad ? '✗' : '✓'} ${path}: ${hrefs.length} row links${dead.length ? `, ${dead.length} open nothing: ${dead.slice(0, 4).join(' | ')}` : ', each opens its row'}${dup.length ? `; ids twice: ${dup.slice(0, 4).join(' ')}` : ''}`);
	}
} finally {
	await browser.close();
}
console.log(failed ? `FAILED (${failed})` : 'every row link opens its row');
process.exit(failed ? 1 : 0);
