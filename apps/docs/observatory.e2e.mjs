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
	// the bundle error is surfaced CLEAN — no rolldown "Build failed" wrapper, no source-frame newlines.
	const errText = await until(page, () => { const t = document.querySelector('[data-obs-bundle-err]')?.textContent || ''; return t.length > 5 ? t : null; });
	ok('bundle error shown cleaned (no "Build failed" prefix/newlines)', !!errText && !/Build failed/.test(errText) && !/\n/.test(errText), (errText || '').slice(0, 50));
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

	// 6b. drag-and-drop: move a file into a folder. neodrag is POINTER-based, so drive it with a real
	//     mouse gesture over the element rects (synthetic native DragEvents wouldn't touch it) — down on
	//     the file, past the 4px threshold, across to the folder header (stepped so the drop engine
	//     samples zones), release. The move must target the hovered folder, not always the root.
	const srcBox = await page.locator('[data-obs-file="src/lib/Counter.svelte"]').boundingBox().catch(() => null);
	const tgtBox = await page.locator('.frow.folder[title="src/routes"]').boundingBox().catch(() => null);
	let dndMoved = false;
	if (srcBox && tgtBox) {
		const sx = srcBox.x + srcBox.width / 2, sy = srcBox.y + srcBox.height / 2;
		const tx = tgtBox.x + tgtBox.width / 2, ty = tgtBox.y + tgtBox.height / 2;
		await page.mouse.move(sx, sy);
		await page.mouse.down();
		await page.mouse.move(sx + 6, sy + 6); // cross the drag threshold
		await page.mouse.move(tx, ty, { steps: 10 }); // travel so drop zones are sampled
		await page.mouse.move(tx, ty); // settle a frame on the target
		await page.mouse.up();
		dndMoved = true;
	}
	await until(page, () => [...document.querySelectorAll('[data-obs-file]')].some((f) => f.getAttribute('data-obs-file') === 'src/routes/Counter.svelte'));
	const dndFiles = await page.evaluate(() => [...document.querySelectorAll('[data-obs-file]')].map((f) => f.getAttribute('data-obs-file')));
	ok('drag-and-drop moves a file into the hovered folder', dndMoved && dndFiles.includes('src/routes/Counter.svelte') && !dndFiles.includes('src/lib/Counter.svelte'), JSON.stringify(dndFiles));

	// 6c. drag a nested file BACK OUT to the workspace root — drop on the tree body's empty area below
	//     the rows (the lowest-priority root zone). The exact bug the redesign fixes is "it always went
	//     to root"; here root is the *intended* target and a folder drop is the default — both must work.
	const rowsBox = await page.locator('.frow.file[data-obs-file="src/routes/Counter.svelte"]').boundingBox().catch(() => null);
	const bodyBox = await page.locator('.ftree-body').boundingBox().catch(() => null);
	let outMoved = false;
	if (rowsBox && bodyBox) {
		const sx = rowsBox.x + rowsBox.width / 2, sy = rowsBox.y + rowsBox.height / 2;
		const tx = bodyBox.x + bodyBox.width / 2, ty = bodyBox.y + bodyBox.height - 6; // empty space at the bottom
		await page.mouse.move(sx, sy);
		await page.mouse.down();
		await page.mouse.move(sx + 6, sy + 6);
		await page.mouse.move(tx, ty, { steps: 10 });
		await page.mouse.move(tx, ty);
		await page.mouse.up();
		outMoved = true;
	}
	await until(page, () => [...document.querySelectorAll('[data-obs-file]')].some((f) => f.getAttribute('data-obs-file') === 'Counter.svelte'));
	const outFiles = await page.evaluate(() => [...document.querySelectorAll('[data-obs-file]')].map((f) => f.getAttribute('data-obs-file')));
	ok('drag-and-drop moves a nested file back to the root', outMoved && outFiles.includes('Counter.svelte') && !outFiles.includes('src/routes/Counter.svelte'), JSON.stringify(outFiles));

	// 6d. drop onto a SIBLING FILE (not a folder header): a file zone outranks its enclosing folder
	//     (priority 2 > 1), so the move targets that file's folder — VS Code-style. Drop the now-root
	//     Counter onto src/lib/Header.svelte → it should land in src/lib.
	const rootBox = await page.locator('.frow.file[data-obs-file="Counter.svelte"]').boundingBox().catch(() => null);
	const sibBox = await page.locator('.frow.file[data-obs-file="src/lib/Header.svelte"]').boundingBox().catch(() => null);
	let sibMoved = false;
	if (rootBox && sibBox) {
		const sx = rootBox.x + rootBox.width / 2, sy = rootBox.y + rootBox.height / 2;
		const tx = sibBox.x + sibBox.width / 2, ty = sibBox.y + sibBox.height / 2;
		await page.mouse.move(sx, sy);
		await page.mouse.down();
		await page.mouse.move(sx + 6, sy + 6);
		await page.mouse.move(tx, ty, { steps: 10 });
		await page.mouse.move(tx, ty);
		await page.mouse.up();
		sibMoved = true;
	}
	await until(page, () => [...document.querySelectorAll('[data-obs-file]')].some((f) => f.getAttribute('data-obs-file') === 'src/lib/Counter.svelte'));
	const sibFiles = await page.evaluate(() => [...document.querySelectorAll('[data-obs-file]')].map((f) => f.getAttribute('data-obs-file')));
	ok('drag onto a sibling file lands in that file’s folder', sibMoved && sibFiles.includes('src/lib/Counter.svelte') && !sibFiles.includes('Counter.svelte'), JSON.stringify(sibFiles));

	// reset to a clean demo app so later assertions aren't on the moved layout
	await page.evaluate(() => [...document.querySelectorAll('[data-obs-presets] button')].find((x) => x.textContent.trim() === 'demo app')?.click());
	await until(page, () => /count is/.test(document.querySelector('[data-obs-preview]')?.textContent || ''));

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
	// a live island authored INSIDE the markdown is interactive (marked imports work in .md — a demo
	// lives next to the prose describing it).
	const islBefore = await page.evaluate(() => [...document.querySelectorAll('[data-obs-preview] button')].find((b) => /count is/.test(b.textContent || ''))?.textContent || '');
	await page.evaluate(() => { const b = [...document.querySelectorAll('[data-obs-preview] button')].find((x) => /count is/.test(x.textContent || '')); b?.click(); });
	await page.waitForTimeout(200);
	const islAfter = await page.evaluate(() => [...document.querySelectorAll('[data-obs-preview] button')].find((b) => /count is/.test(b.textContent || ''))?.textContent || '');
	ok('live island inside markdown is interactive (demo in prose)', /count is/.test(islBefore) && islBefore !== islAfter, `${islBefore}→${islAfter}`);
	// the SAME content island also WAKES in islands mode (the real ogygia runtime hydrates a content
	// island — build_island_info reads the dial-preserved content view). Poll-click until hydration lands.
	await page.evaluate(() => [...document.querySelectorAll('[data-obs-preview-mode] button')].find((x) => x.textContent.trim() === 'islands')?.click());
	await until(page, () => !!document.querySelector('iframe[data-obs-frame]'), undefined, 15000);
	const islandsWoke = await until(page, async () => {
		const d = document.querySelector('iframe[data-obs-frame]')?.contentDocument;
		const btn = d && [...d.querySelectorAll('button')].find((b) => /count is/.test(b.textContent || ''));
		if (!btn) return null;
		const before = btn.textContent;
		btn.click();
		await new Promise((r) => setTimeout(r, 120));
		const after = [...d.querySelectorAll('button')].find((b) => /count is/.test(b.textContent || ''))?.textContent || '';
		return before !== after ? true : null;
	}, undefined, 20000);
	ok('content island wakes in islands mode (real runtime)', !!islandsWoke);
	await page.evaluate(() => [...document.querySelectorAll('[data-obs-preview-mode] button')].find((x) => x.textContent.trim() === 'live')?.click());
	await until(page, () => /Markdown, live/.test(document.querySelector('[data-obs-preview]')?.textContent || ''));
	// editing the markdown recompiles live
	await setSrc(page, S(`# Edited heading RT\n\nplain prose paragraph.\n`));
	const mdEdited = await until(page, () => /Edited heading RT/.test(document.querySelector('[data-obs-preview]')?.textContent || ''));
	ok('markdown recompiles on edit', !!mdEdited);
	// `::: tabs` / `::: code-group` inject ogygia island wrappers — the live mount can't run the island
	// region bridge, so they must degrade to a children passthrough (content shown), NEVER crash to empty.
	await setSrc(page, `# Tabs\n\n::: tabs\n== One\nTAB ONE BODY\n== Two\nTAB TWO BODY\n:::\n`);
	const tabsShown = await until(page, () => { const t = document.querySelector('[data-obs-preview]')?.textContent || ''; return /Tabs/.test(t) && /TAB ONE BODY/.test(t); });
	ok('content tabs degrade to passthrough (content shown, no crash)', !!tabsShown);

	// 9b. the workspace vite.config.ts reconfigures the markdown pipeline live — turn `containers` off and
	// the `::: tip` stops transforming into an admonition (configure ogygia as a real project does).
	await setSrc(page, `# Cfg\n\n::: tip\ncallout body\n:::\n`);
	await until(page, () => !!document.querySelector('[data-obs-preview] .og-admonition'));
	await page.evaluate(() => { const f = [...document.querySelectorAll('[data-obs-file]')].find((x) => /vite\.config/.test(x.getAttribute('data-obs-file') || '')); (f?.querySelector('.fopen') || f)?.click(); });
	await until(page, () => (window.__OBS_SOURCE.get() || '').includes('containers'));
	await setSrc(page, (await page.evaluate(() => window.__OBS_SOURCE.get())).replace('containers: true', 'containers: false'));
	const admGone = await until(page, () => !document.querySelector('[data-obs-preview] .og-admonition') && /callout body/.test(document.querySelector('[data-obs-preview]')?.textContent || ''));
	ok('vite.config.ts reconfigures the preview (containers:false → no admonition)', !!admGone);

	// 9c. the config panel tells the user DELIBERATELY what the preview can't apply — a build-time key,
	//     an unknown markdown option, and a wrong-typed value each surface a note (with a hint). (Still on
	//     vite.config.ts from 9b.)
	await setSrc(page, `import { ogygia } from 'ogygia/vite';\nexport default { plugins: [ogygia({ router: false, content: { markdown: { containers: 'yes', flurb: true } } })] };`);
	const cfgNotes = await until(page, () => {
		const rows = [...document.querySelectorAll('[data-obs-config-note]')].map((n) => (n.getAttribute('data-obs-config-note') || '') + '|' + (n.querySelector('.cn-msg')?.textContent || ''));
		return rows.length >= 3 ? rows : null;
	});
	ok(
		'vite.config notes surface build-time + unknown + illegal options',
		!!cfgNotes &&
			cfgNotes.some((r) => /^info\|.*router.*doesn.t affect/.test(r)) &&
			cfgNotes.some((r) => /^warn\|markdown\.flurb/.test(r)) &&
			cfgNotes.some((r) => /^warn\|markdown\.containers must be true or false/.test(r)),
		JSON.stringify(cfgNotes)
	);

	// back to a svelte preset so later shared-workspace assertions aren't on a .md
	await page.evaluate(() => [...document.querySelectorAll('[data-obs-presets] button')].find((x) => x.textContent.trim() === 'demo app')?.click());
	await until(page, () => /count is/.test(document.querySelector('[data-obs-preview]')?.textContent || ''));

	// 10. a scoped `<style>` must actually PAINT in the live preview (css:'injected' — the REPL bundle has
	// no separate CSS pipeline). Distinctive colour so a computed-style check is unambiguous.
	await setSrc(page, `<div class="obx">STYLED_BOX</div>\n\n<style>\n  .obx { background: rgb(200, 50, 50); padding: 16px; }\n</style>`);
	await until(page, () => document.querySelector('[data-obs-preview]')?.textContent?.includes('STYLED_BOX'));
	const paintedBg = await until(page, () => {
		const el = [...document.querySelectorAll('[data-obs-preview] div')].find((d) => /STYLED_BOX/.test(d.textContent || ''));
		const bg = el ? getComputedStyle(el).backgroundColor : '';
		return bg === 'rgb(200, 50, 50)' ? bg : null;
	});
	ok('scoped <style> paints in the live preview (css injected)', !!paintedBg, `bg=${paintedBg}`);

	// 11. the preview CONSOLE captures + richly formats console.* from the running preview (svelte.dev-style),
	// and auto-opens on an error.
	await setSrc(page, S(`<SCRIPT>\n console.log('mounted', { a: 1, xs: [1, 2] });\n console.error('kaboom', new Map([['k', 1]]));\n</SCRIPT>\n<h1>CONSOLE_TEST</h1>`));
	await until(page, () => /CONSOLE_TEST/.test(document.querySelector('[data-obs-preview]')?.textContent || ''));
	const consoleRows = await until(page, () => {
		const rows = [...document.querySelectorAll('[data-obs-console-row]')].map((r) => (r.getAttribute('data-obs-console-row') || '') + '|' + (r.querySelector('.oc-text')?.textContent || ''));
		return rows.length >= 2 ? rows : null;
	});
	ok('preview console captures + formats logs', !!consoleRows && consoleRows.some((r) => r.includes('log|mounted { a: 1, xs: [ 1, 2 ] }')) && consoleRows.some((r) => r.includes('error|kaboom Map(1) { "k" => 1 }')), JSON.stringify(consoleRows));
	ok('console auto-opens on error', await page.evaluate(() => !!document.querySelector('[data-obs-console].open')));

	// 11c. `region: 'raw'` is a held region rendered via `<Region of={region(Badge, …)}/>` — the REAL
	//      library runs in the worker: region() takes the inline path (no signer) and the badge renders as
	//      zero-JS server HTML. The region map labels it 'held (raw)' (not the build kind 'hydrate'); the
	//      SSR keeps the Counter's `wake="load"` and no empty `wake=""`; and ISLANDS mode renders the badge.
	await page.evaluate(() => [...document.querySelectorAll('[data-obs-presets] button')].find((x) => x.textContent.trim() === 'raw region')?.click());
	await until(page, () => /Held-raw region/.test(document.querySelector('[data-obs-preview]')?.textContent || ''));
	await page.evaluate(() => { const d = [...document.querySelectorAll('details.pipe summary')].find((s) => /rendered HTML source/.test(s.textContent || '')); d?.click(); });
	const rawSsr = await until(page, () => { const t = document.querySelector('[data-obs-html]')?.textContent || ''; return /Held-raw/.test(t) ? t : null; });
	ok('region:raw SSR: no empty wake="", island keeps wake="load", badge HTML rendered', !!rawSsr && !/wake=""/.test(rawSsr) && /wake="load"/.test(rawSsr) && /server HTML/.test(rawSsr), (rawSsr || '').replace(/\s+/g, ' ').slice(0, 120));
	await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find((x) => /Regions/.test(x.textContent || ''))?.click());
	await until(page, () => document.querySelector('[data-obs-modules]'));
	const rawKind = await page.evaluate(() => {
		const map = [...document.querySelectorAll('[data-obs-map] tbody tr')].some((r) => /Badge/.test(r.textContent || '') && /held \(raw\)/.test(r.textContent || ''));
		const mods = [...document.querySelectorAll('[data-obs-modules] summary')].some((s) => /Badge/.test(s.textContent || '') && /held \(raw\)/.test(s.textContent || '') && !/hydrate/.test(s.textContent || ''));
		return map && mods;
	});
	ok('region:raw is labelled "held (raw)" in the map AND generated modules (not "hydrate")', rawKind);
	// islands mode: the worker SSRs the real held region → the badge renders as zero-JS server HTML.
	await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find((x) => /Preview/.test(x.textContent || ''))?.click());
	await page.evaluate(() => [...document.querySelectorAll('[data-obs-preview-mode] button')].find((x) => x.textContent.trim() === 'islands')?.click());
	const rawIslands = await until(page, () => {
		const f = document.querySelector('iframe[data-obs-frame]');
		try { return f?.contentDocument?.querySelector('.badge')?.textContent?.includes('server HTML') ? true : null; } catch { return null; }
	}, undefined, 20000);
	ok('region:raw held region renders as zero-JS server HTML in islands mode', !!rawIslands);
	await page.evaluate(() => [...document.querySelectorAll('[data-obs-preview-mode] button')].find((x) => x.textContent.trim() === 'live')?.click());

	// 11d. `import.meta.og.*` macros run the REAL compiler macro pass in-browser (no stub): `.code` bakes a
	//      Shiki-highlighted snippet, `.md` renders markdown — both inlined as og_html_region and rendered
	//      through the real <Region>. Assert real highlighted tokens + the baked markdown appear.
	await page.evaluate(() => [...document.querySelectorAll('[data-obs-presets] button')].find((x) => x.textContent.trim() === 'macros')?.click());
	const macroOut = await until(page, () => {
		const prev = document.querySelector('[data-obs-preview]');
		if (!prev || !/import\.meta\.og macros/.test(prev.textContent || '')) return null;
		const tokens = prev.querySelectorAll('span[style*="color"]').length;
		const baked = /Baked at build/.test(prev.textContent || '');
		return tokens >= 4 && baked ? { tokens, baked } : null;
	});
	ok('import.meta.og.code/.md run the real macro pass → highlighted code + baked markdown', !!macroOut, JSON.stringify(macroOut));

	// 11e. cross-island CONTEXT via the REAL ogygia primitives (no stub): drop-in `setContext` seeds the
	//      page root ('midnight'); a scoped `<Provide>` shadows it ('sunrise'); both read with a plain
	//      `getContext`. Assert the two islands show the two different values.
	await page.evaluate(() => [...document.querySelectorAll('[data-obs-presets] button')].find((x) => x.textContent.trim() === 'context')?.click());
	const ctxBadges = await until(page, () => {
		const badges = [...document.querySelectorAll('[data-obs-preview] .badge')].map((x) => (x.textContent || '').replace(/\s+/g, ' ').trim());
		return badges.length >= 2 && /midnight/.test(badges[0]) && /sunrise/.test(badges[1]) ? badges : null;
	});
	ok('real ogygia setContext + <Provide> reach islands (read via plain getContext)', !!ctxBadges, JSON.stringify(ctxBadges));

	// back to a svelte preset for the crafted-hash scenario below
	await page.evaluate(() => [...document.querySelectorAll('[data-obs-presets] button')].find((x) => x.textContent.trim() === 'demo app')?.click());
	await until(page, () => /count is/.test(document.querySelector('[data-obs-preview]')?.textContent || ''));

	// 12. a CRAFTED / corrupt share link is untrusted input. A file map with a non-string value would
	//     hand CodeMirror + the compiler a non-string doc and crash the tab. The workspace must sanitize
	//     to string→string on load: drop the bad entry, keep the good one, boot cleanly. (Uncompressed
	//     base64url of the JSON — decode auto-detects: no gzip magic → plain UTF-8 JSON.)
	const craftPayload = JSON.stringify({ f: { 'Bad.svelte': 42, 'Good.svelte': '<h1>SANITIZED_OK</h1>' }, a: 'Good.svelte' });
	const craftHash = Buffer.from(craftPayload, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	// A hash-only goto doesn't reload (the fragment changed, not the path), so set it then reload for real.
	await page.evaluate((h) => { location.hash = h; }, craftHash);
	await page.reload({ waitUntil: 'load' }).catch(() => {});
	const craftBooted = await until(page, () => !!window.__OBS_SOURCE, undefined, 45000);
	await until(page, () => /SANITIZED_OK/.test(document.querySelector('[data-obs-preview]')?.textContent || ''));
	const craftFiles = await page.evaluate(() => [...document.querySelectorAll('[data-obs-file]')].map((f) => f.getAttribute('data-obs-file')));
	ok(
		'crafted share link (non-string file) is sanitized, tab survives',
		craftBooted && craftFiles.includes('Good.svelte') && !craftFiles.includes('Bad.svelte'),
		JSON.stringify(craftFiles)
	);

	ok('no unexpected page errors', pageErrors.length === 0, JSON.stringify([...new Set(pageErrors)].slice(0, 3)));

	console.log(`\n${'─'.repeat(46)}`);
	console.log(`${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`);
	await browser.close();
	process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
