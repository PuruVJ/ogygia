// Observatory end-to-end suite — drives the REAL /observatory page in a headless browser and asserts
// the hard scenarios: the no-$effect reactive wiring, the live rolldown/CDN mount, mode switching, URL
// state, and resilience. Assumes a dev server on http://localhost:5273 (`pnpm dev --port 5273`).
// Run: `node observatory.e2e.mjs`.
import { chromium } from 'playwright';

const URL = process.env.OBS_URL || 'http://localhost:5273/observatory';
let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
	if (cond) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};

/** Poll until `fn()` is truthy (in-page) or timeout; returns the last value. */
async function until(page, fn, arg, ms = 30000, step = 250) {
	const t0 = Date.now();
	let v;
	while (Date.now() - t0 < ms) {
		v = await page.evaluate(fn, arg).catch(() => undefined);
		if (v) return v;
		await page.waitForTimeout(step);
	}
	return v;
}
const previewText = (page) =>
	page.evaluate(() => (document.querySelector('[data-obs-preview]')?.textContent || '').replace(/\s+/g, ' ').trim());
const setSrc = (page, src) => page.evaluate((s) => window.__OBS_SOURCE.set(s), src);
const S = (s) => s.replace(/<SCRIPT>/g, '<scr' + 'ipt>').replace(/<\/SCRIPT>/g, '</scr' + 'ipt>');

async function main() {
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1340, height: 860 } });
	const pageErrors = [];
	page.on('pageerror', (e) => {
		const m = (e.message || '').split('\n')[0];
		if (!/createRequire/.test(m)) pageErrors.push(m.slice(0, 100)); // the createRequire noise is a known dev-only cosmetic
	});
	console.log('Observatory e2e —', URL, '\n');
	await page.goto(URL, { waitUntil: 'load' }).catch(() => {});
	// island booted (the test seam appears)
	const booted = await until(page, () => !!window.__OBS_SOURCE, undefined, 45000);
	ok('island boots (no reactive loop, __OBS_SOURCE present)', !!booted);
	if (!booted) { console.log('FATAL: island never booted'); await browser.close(); process.exit(1); }

	// 1. the default demo mounts + is interactive (the no-$effect mount + per-file linker)
	await until(page, () => /count is/.test(document.querySelector('[data-obs-preview]')?.textContent || ''));
	const btn = page.locator('[data-obs-preview] button').first();
	const c0 = await btn.textContent().catch(() => '');
	await btn.click().catch(() => {});
	await btn.click().catch(() => {});
	await page.waitForTimeout(200);
	const c1 = await btn.textContent().catch(() => '');
	ok('live preview mounts + counter is interactive', /count is/.test(c0) && c0 !== c1, `${c0}→${c1}`);

	// 2. a real npm import from jsdelivr resolves, bundles, and RUNS
	await setSrc(page, S(`<SCRIPT>\n  import { nanoid } from 'nanoid';\n  let id = $state(nanoid());\n</SCRIPT>\n<button onclick={() => id = nanoid()}>id {id}</button>`));
	const cdn = await until(page, () => {
		const t = document.querySelector('[data-obs-preview] button')?.textContent || '';
		// nanoid's alphabet includes `-`/`_` (not just `\w`), so match its full char class — else a `-` in
		// the first chars would break a `\w{10,}` run ~14% of the time (a flaky assertion).
		return /id [\w-]{12,}/.test(t) ? t : null;
	});
	ok('CDN import (nanoid) resolves + runs in the preview', !!cdn, `text=${cdn}`);
	const depReadout = await page.evaluate(() => (document.querySelector('.deps-ok')?.textContent || '').trim());
	ok('resolving readout lists the package', /nanoid/.test(depReadout), depReadout);

	// 3. a CDN Svelte COMPONENT lib (getContext/setContext through the shared runtime) renders
	await setSrc(page, S(`<SCRIPT>\n  import Heart from '@lucide/svelte/icons/heart';\n</SCRIPT>\n<Heart size={30} color="crimson" />`));
	const svg = await until(page, () => document.querySelector('[data-obs-preview] svg')?.getAttribute('stroke') || null);
	ok('CDN svelte component (lucide icon) renders svg', svg === 'crimson', `stroke=${svg}`);

	// 4. a syntax error mid-edit doesn't crash the island; recovery works
	await setSrc(page, S(`<SCRIPT>\n let x = ;;;broken(\n</SCRIPT>\n<h1>{x}`));
	await page.waitForTimeout(1500);
	const alive = await page.evaluate(() => !!document.querySelector('[data-observatory]') && !!window.__OBS_SOURCE);
	ok('syntax error → island stays alive', alive);
	await setSrc(page, S(`<SCRIPT>\n let n = $state(7);\n</SCRIPT>\n<button onclick={() => n++}>n {n}</button>`));
	const recovered = await until(page, () => /n 7/.test(document.querySelector('[data-obs-preview]')?.textContent || ''));
	ok('recovers after a syntax error', !!recovered);

	// 5. URL state round-trip (share link)
	const marker = 'RT_' + Math.random().toString(36).slice(2, 8);
	await setSrc(page, `<h1>${marker}</h1>`);
	await page.waitForTimeout(1400); // hash debounce (400ms) + margin
	const hash = await page.evaluate(() => location.hash);
	ok('edit is encoded into the URL hash', hash.length > 5);
	await page.goto(URL.split('#')[0] + hash, { waitUntil: 'load' }).catch(() => {});
	await until(page, () => !!window.__OBS_SOURCE, undefined, 45000);
	const restored = await until(page, (m) => (window.__OBS_SOURCE.get() || '').includes(m), marker);
	ok('reload restores the workspace from the hash', !!restored);

	// 6. switching files in the tree is navigation, NOT a recompile (no "compiling…")
	await until(page, () => document.querySelectorAll('[data-obs-file]').length > 0);
	await page.evaluate(() => {
		const c = [...document.querySelectorAll('[data-obs-file]')].find((f) => /\.svelte$/.test(f.getAttribute('data-obs-file') || ''));
		c?.querySelector('.fopen')?.click();
	});
	let recompiled = false;
	for (let i = 0; i < 8; i++) {
		await page.waitForTimeout(40);
		if (await page.evaluate(() => !!document.querySelector('.busy.show'))) recompiled = true;
	}
	ok('file-switch is navigation, not a recompile', !recompiled);

	// 7. islands mode → the isolated iframe hydrates
	await page.evaluate(() => [...document.querySelectorAll('[data-obs-preview-mode] button')].find((x) => x.textContent.trim() === 'islands')?.click());
	const frameUp = await until(page, () => !!document.querySelector('iframe[data-obs-frame]'), undefined, 15000);
	ok('islands mode mounts the isolated iframe', !!frameUp);

	// 8. back to live re-mounts cleanly
	await page.evaluate(() => [...document.querySelectorAll('[data-obs-preview-mode] button')].find((x) => x.textContent.trim() === 'live')?.click());
	const backLive = await until(page, () => !!document.querySelector('[data-obs-preview]'), undefined, 10000);
	ok('back to live re-mounts', !!backLive);

	// 9. CONTENT: ogygia's REAL markdown pipeline (mdsvex + shiki + admonitions) runs in the browser and
	// renders a `.md` entry — the same transform the shipped site uses.
	await page.evaluate(() => [...document.querySelectorAll('[data-obs-presets] button')].find((x) => x.textContent.trim() === 'content')?.click());
	const mdHeading = await until(page, () => /Markdown, live/.test(document.querySelector('[data-obs-preview]')?.textContent || ''));
	ok('markdown preset renders (mdsvex pipeline in-browser)', !!mdHeading);
	const mdParts = await page.evaluate(() => {
		const el = document.querySelector('[data-obs-preview]');
		if (!el) return {};
		return {
			admonition: !!el.querySelector('.og-admonition, [class*=admonition]'),
			shiki: !!el.querySelector('.shiki, pre[class*=shiki]'),
			anchor: !!el.querySelector('.og-heading-anchor, a[href^="#"]'),
			table: !!el.querySelector('table')
		};
	});
	ok('markdown: admonition + shiki fence + heading anchor + table all render', mdParts.admonition && mdParts.shiki && mdParts.anchor && mdParts.table, JSON.stringify(mdParts));
	// editing the markdown recompiles live
	await setSrc(page, S(`# Edited heading RT\n\nplain prose paragraph.\n`));
	const mdEdited = await until(page, () => /Edited heading RT/.test(document.querySelector('[data-obs-preview]')?.textContent || ''));
	ok('markdown recompiles on edit', !!mdEdited);
	// `::: tabs` / `::: code-group` inject ogygia island wrappers — the live mount can't run the island
	// region bridge, so they must degrade to a children passthrough (content shown), NEVER crash to empty.
	await setSrc(page, `# Tabs\n\n::: tabs\n== One\nTAB ONE BODY\n== Two\nTAB TWO BODY\n:::\n`);
	const tabsShown = await until(page, () => { const t = document.querySelector('[data-obs-preview]')?.textContent || ''; return /Tabs/.test(t) && /TAB ONE BODY/.test(t); });
	ok('content tabs degrade to passthrough (content shown, no crash)', !!tabsShown);
	// back to a svelte preset so later shared-workspace assertions aren't on a .md
	await page.evaluate(() => [...document.querySelectorAll('[data-obs-presets] button')].find((x) => x.textContent.trim() === 'demo app')?.click());
	await until(page, () => /count is/.test(document.querySelector('[data-obs-preview]')?.textContent || ''));

	ok('no unexpected page errors', pageErrors.length === 0, JSON.stringify([...new Set(pageErrors)].slice(0, 3)));

	console.log(`\n${'─'.repeat(46)}`);
	console.log(`${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`);
	await browser.close();
	process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
