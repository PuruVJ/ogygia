// PRESS EVERYTHING. Every clickable thing in every devtools tab (buttons, links, rows, chips, the
// island card's controls) is pressed once, on each lab page, after a measured load. A press must
// change something (the dock, the page, the scroll, the focus), throw nothing, and never navigate
// away. Found on its first run: a "trace" button that did nothing where the clipboard is refused,
// Hydration rows that did nothing on 8 of 9 islands, and "scroll to it" silent for an island
// already on screen.
//
//   node internal/bench/devtools-click-check.mjs [base=http://127.0.0.1:4183]   (a devtools dev server)
import { createRequire } from 'node:module';

const base = process.argv[2] ?? 'http://127.0.0.1:4183';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const TABS = ['lens', 'page', 'record', 'hydration', 'bytes', 'wire', 'hub', 'nav', 'timeline', 'profiler'];
const PAGES = ['/dt-lab', '/dt-nest', '/dt-third', '/dt-styles'];
// presses that start or end something bigger than a click (a session, a reload, the dock itself)
const SKIP = ['reload', 'close', 'clear', 'record', 'stop', 'forget', 'reset', 'dock', 'undock', 'hide'];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));

// a fingerprint of everything a press can change
const signature = () =>
	page.evaluate(() => {
		const r = document.querySelector('[data-ogygia-devtools-host]')?.shadowRoot;
		if (!r) return 'no dock';
		const hash = (s) => {
			let h = 0;
			for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
			return h;
		};
		const classes = [...r.querySelectorAll('*')].map((e) => e.className?.baseVal ?? e.className).join('|');
		return [hash(r.textContent), hash(classes), r.querySelectorAll('*').length, document.body.innerHTML.length, scrollY, document.activeElement?.tagName].join(':');
	});
const collect = () =>
	page.evaluate(() => {
		const r = document.querySelector('[data-ogygia-devtools-host]').shadowRoot;
		window.__og_clickables = [...r.querySelectorAll('button, a[href], [role="button"], summary, tr, li, [tabindex]')].filter(
			(e) => !e.hasAttribute('data-og-tab') && getComputedStyle(e).cursor === 'pointer' && e.getClientRects().length
		);
		return window.__og_clickables.length;
	});
const open_dock = async () => {
	if (!(await page.locator('[data-og-tab]').count())) {
		await page.click('[data-og-panel-toggle]');
		await page.waitForTimeout(700);
	}
};

let failed = 0;
let pressed = 0;
// SCALE (/dt-many: 320 islands, real pages carry ~340): the dock opens and every tab shows quickly,
// and the page raises no error (its visit is over 64 KB: the beacon's refused send once surfaced
// as an unhandled "Failed to fetch", and the profiler never got the page's browser side)
{
	const e0 = errors.length;
	await page.goto(base + '/dt-many', { waitUntil: 'load' });
	await page.waitForTimeout(2500);
	const timing = await page.evaluate(async (tabs) => {
		const root = () => document.querySelector('[data-ogygia-devtools-host]')?.shadowRoot;
		const toggle = () => document.querySelector('[data-og-panel-toggle]') ?? root()?.querySelector('[data-og-panel-toggle]');
		if (root()?.querySelector('[data-og-tab]')) {
			toggle()?.click();
			await new Promise((ok) => setTimeout(ok, 300));
		}
		const t0 = performance.now();
		toggle()?.click();
		for (let i = 0; i < 300 && !root()?.querySelector('[data-og-tab]'); i++) await new Promise((ok) => setTimeout(ok, 5));
		const open = performance.now() - t0;
		let worst = 0;
		let worst_tab = '';
		for (const t of tabs) {
			const b = root()?.querySelector(`[data-og-tab="${t}"]`);
			const s = performance.now();
			b?.click();
			await new Promise((ok) => requestAnimationFrame(() => setTimeout(ok, 0)));
			const ms = performance.now() - s;
			if (ms > worst) [worst, worst_tab] = [ms, t];
		}
		return { open: Math.round(open), worst: Math.round(worst), worst_tab };
	}, TABS);
	await page.mouse.wheel(0, 4000);
	await page.waitForTimeout(2500);
	const bad = timing.open > 500 || timing.worst > 150 || errors.length > e0;
	if (bad) failed++;
	console.log(`${bad ? '✗' : '✓'} 320 islands: the dock opens in ${timing.open} ms, the slowest tab (${timing.worst_tab}) shows in ${timing.worst} ms${errors.length > e0 ? `; errors: ${errors.slice(e0, e0 + 2).join(' | ')}` : ', no errors'}`);
}
try {
	for (const path of PAGES) {
		await page.goto(base + path, { waitUntil: 'load' });
		await page.waitForTimeout(1500);
		await open_dock();
		// measured from the start: the dock is on before the page loads
		await page.reload({ waitUntil: 'load' });
		await page.waitForTimeout(3500);
		await open_dock();
		for (const tab of TABS) {
			const open_tab = async () => {
				await open_dock();
				await page.click(`[data-og-tab="${tab}"]`);
				await page.waitForTimeout(400);
			};
			await open_tab();
			const n = await collect();
			const dead = [];
			const threw = [];
			for (let i = 0; i < Math.min(n, 80); i++) {
				const label = await page.evaluate((i) => {
					const e = window.__og_clickables[i];
					return e?.isConnected ? `${e.tagName.toLowerCase()} "${(e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50)}"` : null;
				}, i);
				if (!label || SKIP.some((w) => label.toLowerCase().includes(w))) continue;
				const before = await signature();
				const e0 = errors.length;
				const url0 = page.url().split('#')[0];
				await page.evaluate((i) => window.__og_clickables[i].click(), i).catch(() => {});
				await page.waitForTimeout(250);
				pressed++;
				if (errors.length > e0) threw.push(`${label}: ${errors.slice(e0).join(' ; ')}`);
				if (page.url().split('#')[0] !== url0) {
					threw.push(`${label}: navigated to ${page.url()}`);
					await page.goto(base + path, { waitUntil: 'load' });
					await page.waitForTimeout(2500);
					await open_tab();
					await collect();
					continue;
				}
				if ((await signature()) === before) dead.push(label);
				if (!(await page.locator(`[data-og-tab="${tab}"][aria-selected="true"]`).count())) await open_tab();
				await collect();
			}
			if (dead.length || threw.length) {
				failed++;
				console.log(`✗ ${path} · ${tab}: ${dead.length ? `${dead.length} press(es) changed nothing: ${dead.slice(0, 5).join(', ')}` : ''}${threw.length ? ` ${threw.slice(0, 3).join(' | ')}` : ''}`);
			}
		}
		console.log(`· ${path}: every tab pressed`);
	}
} finally {
	await browser.close();
}
console.log(failed ? `FAILED (${failed})` : `✓ every press does something (${pressed} presses, ${PAGES.length} pages × ${TABS.length} tabs), no errors`);
process.exit(failed ? 1 : 0);
