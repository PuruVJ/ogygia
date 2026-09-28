// THE DOCK'S OWN ACCESSIBILITY: axe over the devtools (inside its shadow root) on every tab, and a
// contrast pass of our own — axe cannot decide contrast in the dock ("unable to determine"), so each
// text's color is measured against the background actually under it (translucent layers composed).
// A failure is a text below 4.5:1 (3:1 when large) or an axe violation. Exit code 1 on any.
//
//   node internal/bench/devtools-a11y-check.mjs [base=http://127.0.0.1:4183]   (a devtools dev server)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:4183';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const TABS = ['lens', 'page', 'record', 'hydration', 'bytes', 'wire', 'hub', 'nav', 'timeline', 'profiler'];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(base + '/dt-lab', { waitUntil: 'load' });
await page.waitForTimeout(2500);
await page.addScriptTag({ content: AXE });
await page.click('[data-og-panel-toggle]');
await page.waitForTimeout(1000);

const violations = new Map();
const low = new Map();
const keyboard = new Map();
for (const t of TABS) {
	await page.click(`[data-og-tab="${t}"]`);
	await page.waitForTimeout(500);
	const v = await page.evaluate(async () => {
		const r = await window.axe.run({ include: [['[data-ogygia-devtools-host]']] }, { resultTypes: ['violations'] });
		return r.violations.map((x) => ({ id: x.id, help: x.help, n: x.nodes.length, sample: x.nodes[0]?.html.slice(0, 100) ?? '' }));
	});
	for (const x of v) violations.set(x.id, { ...x, tab: t });
	const c = await page.evaluate(() => {
		const root = document.querySelector('[data-ogygia-devtools-host]').shadowRoot;
		const parse = (s) => {
			const open = s.indexOf('(');
			if (open === -1) return null;
			const parts = s.slice(open + 1, s.indexOf(')')).split(/[ ,/]+/).filter(Boolean).map(Number);
			return [parts[0], parts[1], parts[2], parts[3] ?? 1];
		};
		const lum = ([r, g, b]) => {
			const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
			return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
		};
		const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
		const bg_of = (el) => {
			const layers = [];
			for (let n = el; n; n = n.parentElement || (n.getRootNode()?.host ?? null)) {
				const c = parse(getComputedStyle(n).backgroundColor);
				if (c && c[3] > 0) {
					layers.push(c);
					if (c[3] >= 1) break;
				}
			}
			let out = [255, 255, 255, 1];
			for (const l of layers.reverse()) out = over(l, out);
			return out;
		};
		const out = [];
		const seen = new Set();
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const el = n.parentElement;
			if (!el || seen.has(el) || !n.textContent.trim()) continue;
			seen.add(el);
			const cs = getComputedStyle(el);
			if (cs.visibility === 'hidden' || el.getClientRects().length === 0) continue;
			const fg0 = parse(cs.color);
			if (!fg0) continue;
			const bg = bg_of(el);
			const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * Number(cs.opacity)], bg);
			const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
			const size = parseFloat(cs.fontSize);
			const large = size >= 24 || (Number(cs.fontWeight) >= 700 && size >= 18.66);
			if (ratio < (large ? 3 : 4.5)) out.push({ key: `${cs.color} on ${bg.slice(0, 3).map(Math.round).join(',')}`, ratio: Math.round(ratio * 100) / 100, text: n.textContent.trim().slice(0, 30) });
		}
		return out;
	});
	for (const x of c) low.set(x.key, { ...x, tab: t });
	// THE KEYBOARD: whatever the mouse can press, Tab must reach (a pointer cursor on something
	// with no focusable self or ancestor is a mouse-only control)
	const mouse_only = await page.evaluate(() => {
		const root = document.querySelector('[data-ogygia-devtools-host]').shadowRoot;
		const out = [];
		for (const e of root.querySelectorAll('*')) {
			if (getComputedStyle(e).cursor !== 'pointer' || !e.getClientRects().length) continue;
			if (e.parentElement && getComputedStyle(e.parentElement).cursor === 'pointer') continue;
			const reach = e.matches('button, a[href], input, select, textarea, summary') || e.tabIndex >= 0 || !!e.querySelector('button, a[href], input, select, summary, [tabindex="0"]');
			if (!reach) out.push(`${e.tagName.toLowerCase()} "${(e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30)}"`);
		}
		return out;
	});
	for (const m of mouse_only) keyboard.set(m, t);
}
// Enter on a row's name opens the island's card, as a click on the row does
await page.click('[data-og-tab="lens"]');
await page.waitForTimeout(300);
await page.locator('[data-og-win] tbody .rowbtn').first().focus();
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
const card_by_key = (await page.locator('[data-og-detail]').count()) === 1;
await browser.close();

for (const [id, x] of violations) console.log(`✗ axe ${id} (${x.tab}) — ${x.help}: ${x.sample}`);
for (const [k, x] of low) console.log(`✗ contrast ${x.ratio}:1 — ${k} "${x.text}" (${x.tab})`);
for (const [m, t] of keyboard) console.log(`✗ keyboard: ${m} (${t}) takes a mouse press but Tab never reaches it`);
if (!card_by_key) console.log('✗ keyboard: Enter on a Lens row did not open its island card');
const ok = !violations.size && !low.size && !keyboard.size && card_by_key;
console.log(ok ? `✓ the dock passes axe, contrast and the keyboard on all ${TABS.length} tabs` : 'FAILED');
process.exit(ok ? 0 : 1);
