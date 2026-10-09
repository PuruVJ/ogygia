// PRESS EVERYTHING, ON THE PROFILER'S PAGES: a report, the dashboard, the compare page. Every
// sort header, filter chip, row, tab, toggle and in-page link is pressed once. A press must change
// something (the text, a class, an open or checked state, the scroll, the hash, the focus), throw
// nothing, and never leave the page. Toggles already on are left out (pressing one changes nothing
// by design). Buttons that start work (profile, export, download, share, delete) are left out too.
// Found on its first run: a row link pressed a second time did nothing (the hash did not change,
// so no hashchange fired).
//
//   node internal/bench/profiler-click-check.mjs http://127.0.0.1:4196 <profiler key>
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:4196';
const H = { 'x-profiler-key': process.argv[3] ?? 'hell' };
const SKIP = ['download', 'export', 'share', 'keep', 'delete', 'forget', 'reset', 'stop', 'profile', 'record', 'remove', '.ogp', 'json', 'html', 'cpuprofile', 'clear', 'import'];

async function profile(path) {
	for (let i = 0; i < 20; i++) {
		const r = await fetch(`${base}/__profiler/page?p=${encodeURIComponent(path)}&runs=2`, { headers: H, redirect: 'manual' });
		const loc = r.headers.get('location');
		if (loc) return loc.split('/').pop();
		await new Promise((ok) => setTimeout(ok, 1500));
	}
	throw new Error(`no report for ${path}`);
}

const a = await profile('/mixed');
const b = await profile('/inferno-deals');
const PAGES = [`/__profiler/report/${a}`, '/__profiler', `/__profiler/compare/${a}/${b}`];

const browser = await chromium.launch();
const page = await (await browser.newContext({ extraHTTPHeaders: H, viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));

const signature = () =>
	page.evaluate(() => {
		const hash = (s) => {
			let h = 0;
			for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
			return h;
		};
		const state = [...document.querySelectorAll('*')]
			.map((e) => `${e.className?.baseVal ?? e.className}${e.open ? 'O' : ''}${e.checked ? 'C' : ''}${e.getAttribute('aria-expanded') ?? ''}${e.getAttribute('aria-selected') ?? ''}${(e.getAttribute('style') ?? '').length}`)
			.join('|');
		return [hash(document.body.innerText), hash(state), document.querySelectorAll('*').length, Math.round(scrollY), location.hash, document.activeElement?.tagName].join(':');
	});
const collect = () =>
	page.evaluate(() => {
		window.__og_press = [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"], summary, th, tr, li, label, [tabindex]')].filter(
			(e) =>
				getComputedStyle(e).cursor === 'pointer' &&
				e.getClientRects().length &&
				// a toggle that is already on
				!(e.classList.contains('on') || e.getAttribute('aria-pressed') === 'true' || e.getAttribute('aria-selected') === 'true' || e.classList.contains('picked'))
		);
		return window.__og_press.length;
	});

let failed = 0;
let pressed = 0;
try {
	for (const url of PAGES) {
		await page.goto(base + url, { waitUntil: 'load' });
		await page.waitForTimeout(1200);
		const n = await collect();
		const dead = [];
		const threw = [];
		for (let i = 0; i < n; i++) {
			const it = await page.evaluate((i) => {
				const e = window.__og_press[i];
				if (!e?.isConnected) return null;
				return { label: `${e.tagName.toLowerCase()} "${(e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50)}"`, href: e.getAttribute('href') };
			}, i);
			// plain links leave the page by design; buttons that start work are not a press's business
			if (!it || (it.href && !it.href.startsWith('#')) || SKIP.some((w) => it.label.toLowerCase().includes(w))) continue;
			// look at it first, as a person pressing it would (a link to where the page already is
			// changes nothing; from the link's own place, it jumps)
			await page.evaluate((i) => window.__og_press[i].scrollIntoView({ block: 'center' }), i);
			await page.waitForTimeout(60);
			const before = await signature();
			const e0 = errors.length;
			const url0 = page.url().split('#')[0];
			await page
				.evaluate((i) => {
					const e = window.__og_press[i];
					// (an SVG link has no click())
					if (e.click) e.click();
					else e.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
				}, i)
				.catch(() => {});
			await page.waitForTimeout(450);
			pressed++;
			if (errors.length > e0) threw.push(`${it.label}: ${errors.slice(e0).join(' ; ')}`);
			if (page.url().split('#')[0] !== url0) {
				threw.push(`${it.label}: left the page for ${page.url()}`);
				await page.goto(base + url, { waitUntil: 'load' });
				await page.waitForTimeout(1000);
				await collect();
				continue;
			}
			if ((await signature()) === before) dead.push(it.label);
		}
		// THE KEYBOARD: whatever takes a mouse press, Tab reaches (the two canvases are pictures of
		// tables the page also has; the flame graph's search box zooms by Enter)
		const mouse_only = await page.evaluate(() => {
			const out = [];
			for (const e of document.querySelectorAll('*')) {
				if (e.tagName === 'CANVAS' || getComputedStyle(e).cursor !== 'pointer' || !e.getClientRects().length) continue;
				if (e.parentElement && getComputedStyle(e.parentElement).cursor === 'pointer') continue;
				const reach = e.matches('button, a[href], input, select, textarea, summary, label') || e.tabIndex >= 0 || !!e.querySelector('button, a[href], input, select, summary, [tabindex="0"]');
				if (!reach) out.push(`${e.tagName.toLowerCase()} "${(e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30)}"`);
			}
			return out;
		});
		if (mouse_only.length) threw.push(`${mouse_only.length} mouse-only control(s): ${mouse_only.slice(0, 4).join(', ')}`);
		// Enter on a sort header sorts, and says so
		const th = page.locator('th.sort').first();
		if (await th.count()) {
			await page.goto(base + url, { waitUntil: 'load' });
			await page.waitForTimeout(800);
			const sort0 = await th.getAttribute('aria-sort');
			await th.focus();
			await page.keyboard.press('Enter');
			await page.waitForTimeout(200);
			if ((await th.getAttribute('aria-sort')) === sort0) threw.push('Enter on a sort header did not change its aria-sort');
		}
		const name = url.split('/').slice(0, 3).join('/');
		if (dead.length || threw.length) {
			failed++;
			console.log(`✗ ${name}: ${dead.length ? `${dead.length} press(es) changed nothing: ${dead.slice(0, 5).join(', ')}` : ''}${threw.length ? ` ${threw.slice(0, 3).join(' | ')}` : ''}`);
		} else console.log(`✓ ${name}: ${n} pressable, each does something`);
	}
} finally {
	await browser.close();
}
console.log(failed ? `FAILED (${failed})` : `every press does something (${pressed} presses), no errors`);
process.exit(failed ? 1 : 0);
