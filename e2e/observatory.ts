// OBSERVATORY (browser compiler, Rung 1 v0): the ogygia mark analysis runs in the BROWSER, in a Web
// Worker — svelte/compiler parses the component, the real `with { … }` island marks are resolved to
// strategies, and the host is rewritten (marked import → virtual wrapper). Asserts: the island mounts,
// exactly ONE worker is spawned (no per-keystroke runaway), the island map resolves every strategy,
// the host rewrite lands, and a live edit updates the map off the main thread.
// Usage: node e2e/observatory.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const workers: string[] = [];
	page.on('worker', (w) => workers.push(w.url()));
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));

	await page.goto(base + '/observatory', { waitUntil: 'load' });
	await page.waitForSelector('[data-obs-map] tbody tr', { timeout: 10000 }).catch(() => {});
	await page.waitForTimeout(400);

	// "islands" mode renders in an ISOLATED iframe (/observatory-frame); query INSIDE it.
	const frameEval = async <T>(fn: () => T): Promise<T | null> => {
		const f = page.frames().find((fr) => fr.url().includes('observatory-frame'));
		if (!f) return null;
		try {
			return await f.evaluate(fn);
		} catch {
			return null;
		}
	};
	const frameLoc = (sel: string) => page.frameLocator('[data-obs-frame]').locator(sel);
	const toIslands = async () => {
		await page.evaluate(() => {
			const b = [...document.querySelectorAll('[data-obs-preview-mode] button')].find((x) => x.textContent?.trim() === 'islands');
			(b as HTMLElement)?.click();
		});
		await page.waitForTimeout(2600); // iframe load + harness ready + render + hydrate
	};
	const toMode = async (mode: string) => {
		await page.evaluate((m) => {
			const b = [...document.querySelectorAll('[data-obs-preview-mode] button')].find((x) => x.textContent?.trim() === m);
			(b as HTMLElement)?.click();
		}, mode);
		await page.waitForTimeout(200);
	};
	const preset = async (name: string) => {
		await page.evaluate((n) => {
			const b = [...document.querySelectorAll('[data-obs-presets] button')].find((x) => x.textContent === n);
			(b as HTMLElement)?.click();
		}, name);
		await page.waitForTimeout(800);
	};

	check('observatory island mounted', (await page.locator('[data-observatory]').count()) === 1);
	// >= 1: our compile worker, plus the WASI helper threads rolldown-browser's WASM spawns for oxc.
	check('runs its compile in a Web Worker', workers.length >= 1, `${workers.length} worker(s) incl. WASI threads`);

	// ── EXECUTION first: the DEFAULT (multi-file demo) renders its REAL components (no stubs) ──
	const rendered = await page.evaluate(() => {
		const el = document.querySelector('[data-obs-preview]');
		return el ? { text: (el.textContent || '').trim(), stubs: el.querySelectorAll('[data-og-stub]').length } : null;
	});
	check('the multi-file app RENDERS its real components in-browser', !!rendered && /count is 3/.test(rendered.text) && rendered.stubs === 0, JSON.stringify(rendered));
	const fileTabs = await page.evaluate(() => document.querySelectorAll('[data-obs-filetabs] .filetab').length);
	check('multi-file editor shows file tabs', fileTabs >= 4, `${fileTabs} tabs`);

	// ── INTERACTIVE: the mounted preview actually runs — click the counter, it increments ──
	const btnBefore = await page.evaluate(() => document.querySelector('[data-obs-preview] button')?.textContent?.trim() || '');
	await page.click('[data-obs-preview] button').catch(() => {});
	await page.click('[data-obs-preview] button').catch(() => {});
	await page.waitForTimeout(150);
	const btnAfter = await page.evaluate(() => document.querySelector('[data-obs-preview] button')?.textContent?.trim() || '');
	check('the rendered app is INTERACTIVE (mounted, client-hydrated)', btnBefore === 'count is 3' && btnAfter === 'count is 5', `${btnBefore} → ${btnAfter}`);

	// ── BOUNDARY LENS (x-ray): every marked region is a tinted island; the dead shell stays grey ──
	await page.evaluate(() => {
		const btn = [...document.querySelectorAll('[data-obs-preview-mode] button')].find((b) => b.textContent?.trim() === 'x-ray');
		(btn as HTMLElement)?.click();
	});
	await page.waitForTimeout(250);
	const lens = await page.evaluate(() => {
		const pv = document.querySelector('[data-obs-preview]');
		const islands = [...document.querySelectorAll('[data-obs-preview] [data-obs-island]')].map((el) => ({
			name: el.getAttribute('data-name'),
			kind: el.getAttribute('data-kind'),
			ships: el.getAttribute('data-ships')
		}));
		return { xray: pv?.classList.contains('xray'), legend: !!document.querySelector('[data-obs-legend]'), islands };
	});
	check('boundary lens: x-ray mode tints the preview + shows a legend', !!lens.xray && lens.legend, JSON.stringify({ xray: lens.xray, legend: lens.legend }));
	check('boundary lens: the island (Counter) and the lake (Prose) are marked regions, the shell is not', lens.islands.some((i) => i.name === 'Counter.svelte' && i.kind === 'island' && i.ships === 'true') && lens.islands.some((i) => i.name === 'Prose.svelte' && i.kind === 'lake' && i.ships === 'false') && !lens.islands.some((i) => i.name === 'Header.svelte'), JSON.stringify(lens.islands));
	// ── ISLANDS MODE (crown jewel): the app renders with REAL <ogygia-region> shells in an ISOLATED
	//    iframe whose own ogygia runtime hydrates them — the actual framework, fully sandboxed ──
	await toIslands();
	const island = await frameEval(() => {
		const r = document.querySelector('#obs-app ogygia-region[data-obs-real-island]');
		return r ? { name: r.getAttribute('data-name'), blobEntry: (r.getAttribute('entry') || '').startsWith('blob:'), nested: r.hasAttribute('data-nested') } : null;
	});
	check('islands mode: the iframe renders a REAL <ogygia-region> (blob entry, not skipped as nested)', !!island && island.name === 'Counter.svelte' && island.blobEntry && !island.nested, JSON.stringify(island));
	const ri0 = await frameEval(() => document.querySelector('#obs-app ogygia-region button')?.textContent?.trim() || '');
	await frameLoc('#obs-app ogygia-region button').click().catch(() => {});
	await frameLoc('#obs-app ogygia-region button').click().catch(() => {});
	await page.waitForTimeout(200);
	const ri1 = await frameEval(() => document.querySelector('#obs-app ogygia-region button')?.textContent?.trim() || '');
	check("islands mode: the iframe's own runtime hydrates the island — it is interactive", ri0 === 'count is 3' && ri1 === 'count is 5', `${ri0} → ${ri1}`);
	// the real runtime's hydration events flow to the Observatory off the devtools bus (Rung 0 → instrument).
	// Only when the served build compiled devtools IN (the runtime emits behind __OGYGIA_DEVTOOLS__); the
	// default suite builds devtools OFF (tree-shaken), so skip-pass there — exactly like e2e/devtools.ts.
	const devtoolsOn = await page.evaluate(() => typeof (window as { __ogygia_devtools?: unknown }).__ogygia_devtools !== 'undefined');
	if (devtoolsOn) {
		const rtEvents = await page.evaluate(() => [...document.querySelectorAll('[data-obs-runtime-events] .rtev-row')].map((r) => r.textContent?.replace(/\s+/g, ' ').trim() || ''));
		check('islands mode: real runtime events stream to the bus (connected → woke → hydrated)', rtEvents.some((e) => /connected/.test(e)) && rtEvents.some((e) => /woke/.test(e)) && rtEvents.some((e) => /hydrated/.test(e)), JSON.stringify(rtEvents));
	} else {
		results.push('SKIP  islands mode: real runtime events (served build has devtools off — tree-shaken)');
	}

	// ── CSR SWITCH: flip csr=true → the transform strips islands to plain AND the iframe mounts the
	//    WHOLE app (Kit-style, no <ogygia-region>), interactive from load; flip back → islands ──
	const outFalse = await page.evaluate(() => document.querySelector('[data-obs-output]')?.textContent || '');
	await page.click('[data-obs-csr] button:last-child').catch(() => {}); // csr=true
	await page.waitForTimeout(1500);
	const outTrue = await page.evaluate(() => document.querySelector('[data-obs-output]')?.textContent || '');
	check('csr switch: csr=true strips the transform to plain (no virtual:ogygia wrappers)', /virtual:ogygia/.test(outFalse) && !/virtual:ogygia/.test(outTrue), `false→${/virtual:ogygia/.test(outFalse)} true→${!/virtual:ogygia/.test(outTrue)}`);
	const kit = await frameEval(() => ({ regions: document.querySelectorAll('#obs-app ogygia-region').length, btn: document.querySelector('#obs-app button')?.textContent?.trim() || '' }));
	const kb0 = kit?.btn || '';
	await frameLoc('#obs-app button').first().click().catch(() => {});
	await page.waitForTimeout(150);
	const kb1 = await frameEval(() => document.querySelector('#obs-app button')?.textContent?.trim() || '');
	check('csr switch: csr=true mounts the WHOLE app in the iframe (0 regions) + it is interactive', kit?.regions === 0 && kb0 === 'count is 3' && kb1 === 'count is 4', JSON.stringify({ regions: kit?.regions, k: `${kb0}→${kb1}` }));
	await page.click('[data-obs-csr] button:first-child').catch(() => {}); // back to csr=false
	await page.waitForTimeout(1500);

	// back to the live preview for the remaining checks
	await page.evaluate(() => {
		const btn = [...document.querySelectorAll('[data-obs-preview-mode] button')].find((b) => b.textContent?.trim() === 'live');
		(btn as HTMLElement)?.click();
	});
	await page.waitForTimeout(150);

	// ── BYTE LEDGER: the ogygia thesis, weighed live — ogygia ships only the waking island, plain Kit
	//    (csr=true) ships every component; the demo saves ~75% of the app JS ──
	const ledger = await page.evaluate(() => {
		const led = document.querySelector('[data-obs-ledger]');
		if (!led) return null;
		const num = (sel: string) => document.querySelector(sel)?.textContent || '';
		const rows = [...led.querySelectorAll('.ltable tr')].map((r) => ({
			name: r.querySelector('.lname')?.textContent?.trim() || '',
			ships: r.classList.contains('ships')
		}));
		return { saved: num('[data-obs-saved]').trim(), og: num('[data-obs-og-bytes]'), kit: num('[data-obs-kit-bytes]'), rows };
	});
	check('byte ledger present', !!ledger, JSON.stringify(ledger?.saved));
	check('byte ledger: ogygia ships FEWER components than plain Kit', !!ledger && ledger.rows.filter((r) => r.ships).length < ledger.rows.length, JSON.stringify(ledger?.rows));
	check('byte ledger: only the waking island (Counter) ships, the lake/shell do not', !!ledger && ledger.rows.find((r) => r.name === 'Counter.svelte')?.ships === true && ledger.rows.find((r) => r.name === 'Prose.svelte')?.ships === false && ledger.rows.find((r) => r.name === 'App.svelte')?.ships === false, JSON.stringify(ledger?.rows));
	check('byte ledger: shows a real JS saving (csr=false vs csr=true)', !!ledger && /−\d+% JS/.test(ledger.saved), ledger?.saved);

	// ── WIRE INSPECTOR: the real props each island receives, by value (devalue). Counter gets start=3;
	//    Prose receives only children (a region snippet), so nothing crosses as a prop ──
	const wire = await page.evaluate(() =>
		[...document.querySelectorAll('[data-obs-wire] .wrow')].map((r) => ({
			name: r.querySelector('.wname')?.textContent?.trim() || '',
			payload: r.querySelector('.wpay')?.textContent?.trim() || '',
			empty: !!r.querySelector('.wempty')
		}))
	);
	check('wire inspector: Counter receives its start prop by value', wire.some((w) => w.name === 'Counter.svelte' && /start/.test(w.payload) && /3/.test(w.payload)), JSON.stringify(wire));
	check('wire inspector: Prose receives only children (a snippet) — no props cross', wire.some((w) => w.name === 'Prose.svelte' && w.empty), JSON.stringify(wire));

	// ── WAKE VISUALIZER: on the "wake demo" preset, x-ray arms each island's REAL schedule — load
	//    fires immediately, interaction waits for a click, the lake stays frozen ──
	await page.evaluate(() => {
		const btn = [...document.querySelectorAll('[data-obs-presets] button')].find((b) => b.textContent === 'wake demo');
		(btn as HTMLElement)?.click();
	});
	await page.waitForTimeout(500);
	await page.evaluate(() => {
		const btn = [...document.querySelectorAll('[data-obs-preview-mode] button')].find((b) => b.textContent?.trim() === 'x-ray');
		(btn as HTMLElement)?.click();
	});
	await page.waitForTimeout(300); // let the load-wake fire
	const wokeState = () =>
		page.evaluate(() =>
			Object.fromEntries(
				[...document.querySelectorAll('[data-obs-preview] [data-obs-island]')].map((n) => [n.getAttribute('data-name'), n.getAttribute('data-woke')])
			)
		);
	const w1 = await wokeState();
	check('wake viz: the load island wakes immediately', w1['Counter.svelte'] === 'true', JSON.stringify(w1));
	check('wake viz: the lake never wakes (frozen)', w1['Prose.svelte'] === 'frozen', JSON.stringify(w1));
	check('wake viz: the interaction island is still asleep before any input', w1['Menu.svelte'] === 'false', JSON.stringify(w1));
	// wake the interaction island with a real pointer event inside it
	await page.evaluate(() => {
		const btn = [...document.querySelectorAll('[data-obs-preview] [data-obs-island] button')].find((b) => /Menu/.test(b.textContent || ''));
		btn?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
	});
	await page.waitForTimeout(150);
	const w2 = await wokeState();
	check('wake viz: the interaction island wakes on the first pointer inside it', w2['Menu.svelte'] === 'true', JSON.stringify(w2));
	// restore the default demo + live preview for any later runs
	await page.evaluate(() => {
		const btn = [...document.querySelectorAll('[data-obs-presets] button')].find((b) => b.textContent === 'demo app');
		(btn as HTMLElement)?.click();
	});
	await page.waitForTimeout(300);

	// ── switch to the "all strategies" preset to exercise every island kind in the transform ──
	await page.evaluate(() => {
		const btn = [...document.querySelectorAll('[data-obs-presets] button')].find((b) => b.textContent === 'all strategies');
		(btn as HTMLElement)?.click();
	});
	await page.waitForTimeout(600);

	const strategies = await page.evaluate(() =>
		[...document.querySelectorAll('[data-obs-map] .badge')].map((b) => b.textContent)
	);
	check('island map resolves every strategy from real marks', strategies.length >= 6, JSON.stringify(strategies));
	for (const s of ['island', 'server hole', 'lake', 'held (raw)']) {
		check(`island map has a '${s}' region`, strategies.includes(s));
	}

	const out = await page.evaluate(() => document.querySelector('[data-obs-output]')?.textContent || '');
	// The REAL transform rewrites marked imports to virtual island/wrapper ids (real md5).
	check('host rewrite: marked import → virtual island/wrapper', /virtual:ogygia\/(island|region|wrapper)\/[0-9a-f]+/.test(out), out.slice(0, 80));

	// ── THE BIG ONE: the real ogygia transformHost ran in the browser ──
	const realBadge = await page.evaluate(() => document.querySelector('[data-obs-real]')?.textContent || '');
	check('the REAL ogygia transform runs in-browser (not the mark-reader)', /real ogygia transform/.test(realBadge), realBadge);
	const realIds = await page.evaluate(() => document.querySelectorAll('.realdot').length);
	check('island map shows REAL md5 region ids from the transform', realIds > 0, `${realIds} real ids`);

	// ── live edit: add a marked import, expect the map to grow — off the main thread ──
	const before = strategies.length;
	const workersBeforeEdit = workers.length; // WASI threads already spawned; edits must not add more
	await page.evaluate(() => {
		const ta = document.querySelector('[data-obs-input]') as HTMLTextAreaElement;
		const next = ta.value.replace('</scr' + 'ipt>', "  import X from './X.svelte' with { wake: 'idle' };\n</scr" + 'ipt>');
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
		setter.call(ta, next);
		ta.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForTimeout(500);
	const after = await page.evaluate(() => document.querySelectorAll('[data-obs-map] .badge').length);
	check('live edit updates the island map', after === before + 1, `${before} → ${after}`);
	check('worker count stable across edits (no per-keystroke runaway)', workers.length === workersBeforeEdit, `${workersBeforeEdit} → ${workers.length}`);
	// The real oxc parser (rolldown-browser WASM) parsed in-browser — the browser-compiler unlock.
	const oxcOk = await page.evaluate(() => document.querySelector('[data-obs-oxc]')?.classList.contains('ok'));
	check('real oxc parser (rolldown-browser WASM) parses in-browser', !!oxcOk);
	check('page is cross-origin isolated (COOP/COEP for the WASM)', await page.evaluate(() => self.crossOriginIsolated));
	check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

	// ── SERVER ISLANDS (deferred) in the iframe: the deferred region's HTML is FETCHED from its endpoint
	//    (a fetch intercept in the frame plays the server) and swapped in ──
	await toMode('live');
	await preset('server island');
	await toIslands();
	const deferMeta = await frameEval(() => {
		const r = document.querySelector('#obs-app ogygia-region[data-obs-deferred]');
		return r ? { render: r.getAttribute('render'), endpoint: r.getAttribute('endpoint') } : null;
	});
	// (the loading fallback is transient — the fetch's 260ms delay lands during the iframe load wait; the
	//  swap check below proves the fetch → content path.)
	check('server island: a real deferred region renders with a signed-style fetch endpoint', !!deferMeta && deferMeta.render === 'defer' && /\/__obs_defer\//.test(deferMeta.endpoint || ''), JSON.stringify(deferMeta));
	await page.waitForTimeout(900); // the fetch (with its small delay) lands + swaps
	const swapped = (await frameEval(() => document.querySelector('#obs-app ogygia-region[data-obs-deferred]')?.textContent?.replace(/\s+/g, ' ').trim() || '')) || '';
	check('server island: the endpoint HTML is fetched on schedule + swapped in (fallback → content)', /Welcome back, Ada/.test(swapped) && !/loading/i.test(swapped), swapped.slice(0, 80));

	// ── LIVE REGIONS (render: 'live') in the iframe: a <ogygia-region live> re-renders on a tick and the
	//    frame's runtime MORPHS it in place, so a focused input's text survives the update ──
	await toMode('live');
	await preset('live region');
	await toIslands();
	const tickBefore = (await frameEval(() => document.querySelector('#obs-app ogygia-region[data-obs-live]')?.textContent?.match(/re-rendered (\d+)/)?.[1] || '')) || '';
	await frameLoc('#obs-app ogygia-region[data-obs-live] input').click().catch(() => {});
	await frameLoc('#obs-app ogygia-region[data-obs-live] input').pressSequentially('KEEPME').catch(() => {});
	await page.waitForTimeout(3600);
	const live = await frameEval(() => ({
		tick: document.querySelector('#obs-app ogygia-region[data-obs-live]')?.textContent?.match(/re-rendered (\d+)/)?.[1] || '',
		value: (document.querySelector('#obs-app ogygia-region[data-obs-live] input') as HTMLInputElement | null)?.value || '',
		focused: document.activeElement?.tagName === 'INPUT'
	}));
	check('live region: the frame runtime re-renders + MORPHS it in place (the tick advances)', Number(live?.tick) > Number(tickBefore || '0'), `${tickBefore} → ${live?.tick}`);
	check('live region: the morph keeps focus + typed text (not a re-mount)', live?.value === 'KEEPME' && live?.focused, JSON.stringify(live));

	// ── KEEP · NAV (the real reconcile) in the iframe: bump a keep counter on Home, navigate to About —
	//    the live island is RELOCATED (its count survives) while page-specific islands mount/remove ──
	await toMode('live');
	await preset('keep · nav');
	await toIslands();
	for (let i = 0; i < 3; i++) {
		await frameLoc('#obs-app ogygia-region[data-ogygia-keep] button').click().catch(() => {});
		await page.waitForTimeout(70);
	}
	const keptText = (await frameEval(() => document.querySelector('#obs-app ogygia-region[data-ogygia-keep] button')?.textContent?.trim() || '')) || '';
	const homeBefore = await frameEval(() => /Home widget/.test(document.getElementById('obs-app')?.textContent || ''));
	check('keep·nav: on Home, the kept counter shows 3 and the Home-only island is present', /kept count: 3/.test(keptText) && !!homeBefore, `${keptText} | home=${homeBefore}`);
	await frameLoc('#obs-app a[data-obs-nav="About.svelte"]').click().catch(() => {});
	await page.waitForTimeout(1300);
	const nav = await frameEval(() => ({
		counter: document.querySelector('#obs-app ogygia-region[data-ogygia-keep] button')?.textContent?.trim() || '',
		home: /Home widget/.test(document.getElementById('obs-app')?.textContent || ''),
		about: /About widget/.test(document.getElementById('obs-app')?.textContent || '')
	}));
	const readout = await page.evaluate(() => document.querySelector('[data-obs-navinfo]')?.textContent?.replace(/\s+/g, ' ').trim() || '');
	check('keep·nav: the kept island survives the nav with its state (count still 3)', /kept count: 3/.test(nav?.counter || ''), nav?.counter);
	check('keep·nav: page islands reconcile — Home widget removed, About widget mounted', !nav?.home && !!nav?.about, JSON.stringify({ home: nav?.home, about: nav?.about }));
	check('keep·nav: the reconcile readout reports kept/mounted/removed', /kept Counter/.test(readout) && /mounted AboutWidget/.test(readout) && /removed HomeWidget/.test(readout), readout);
	await frameLoc('#obs-app a[data-obs-nav="App.svelte"]').click().catch(() => {});
	await page.waitForTimeout(1300);
	const back = await frameEval(() => ({
		counter: document.querySelector('#obs-app ogygia-region[data-ogygia-keep] button')?.textContent?.trim() || '',
		home: /Home widget/.test(document.getElementById('obs-app')?.textContent || '')
	}));
	check('keep·nav: navigating BACK still keeps the counter (3) + restores the Home island', /kept count: 3/.test(back?.counter || '') && !!back?.home, JSON.stringify(back));

	// ── THEME: the preview theme toggle writes `og-theme`; the same-origin iframe re-themes to match
	//    (the same mechanism the docs ThemeToggle uses, so it'll sync once embedded there) ──
	await page.click('[data-obs-theme]').catch(() => {}); // system → light
	await page.waitForTimeout(150);
	await page.click('[data-obs-theme]').catch(() => {}); // light → dark
	await page.waitForTimeout(400);
	const frameTheme = await frameEval(() => document.documentElement.getAttribute('data-theme'));
	check('theme: the toggle re-themes the isolated iframe (synced via the og-theme key)', frameTheme === 'dark', String(frameTheme));

	await page.close();
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL OBSERVATORY CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
