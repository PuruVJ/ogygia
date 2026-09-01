// REGRESSION: the production `$app/stores` split brain, reproduced end to end.
//
// The shape (seen live on a deployed ogygia 0.5.1 app): a Header island whose FIRST import is
// `$app/stores`, siblings importing the same module LATER in the list, and the same file also
// imported PLAIN by a csr=true page. Under lazy island-graph membership, build order decided
// which `$app/*` each copy got: the header bundled Kit's REAL client store — whose page store
// never populates under csr=false — while its siblings got the shim. `$page.url.pathname` threw
// "Cannot read properties of undefined (reading 'pathname')" during hydrate and the header was
// torn out of the page. The EAGER transitive island-graph walk makes membership deterministic
// (the `?og-region` module-id fork was tried and reverted — it broke scoped-CSS emission), so a
// shared module is shimmed EVERYWHERE, including the csr=true copy.
//
// SECOND LEG (the bcms all-products outage): a shared component reading `$page.data.x.method()`
// in onMount. The shimmed csr=true copy read `data: {}` (the island seed never runs on a
// Kit-booted document), threw inside Kit's synchronous hydrate flush, and killed every mount
// after it. The KIT-WORLD PAGE THREAD fixes this: Kit's generated client entry publishes its
// REAL reactive `page` on `Symbol.for('ogygia.kit-page')` (two appended lines, zero bytes —
// see KIT_PAGE_THREAD in vite/index.ts), and the shims read through it whenever it exists.
//
//   node e2e/split-brain.ts http://localhost:3051

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] || 'http://localhost:3051';
const repo = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;
const out: string[] = [];
function check(name: string, cond: boolean, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
try {
	// ── Region world: csr=false page, the header must hydrate with the shim ──────────────
	const page = await browser.newPage();
	const errs: string[] = [];
	page.on('pageerror', (e) => errs.push(e.message));
	page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

	await page.goto(base + '/split-brain', { waitUntil: 'networkidle' });
	await page
		.waitForSelector('ogygia-region[data-hydrated] [data-split-header]', { timeout: 8000 })
		.catch(() => {});
	await sleep(300);

	// The original symptom was the header VANISHING after hydration failed.
	check(
		'csr=false: header still in the DOM after hydration',
		(await page.locator('[data-split-header]').count()) === 1
	);
	const regionPath = ((await page.locator('[data-split-path]').textContent()) ?? '').trim();
	const childPath = ((await page.locator('[data-split-child-path]').textContent()) ?? '').trim();
	const grandPath = ((await page.locator('[data-split-grandchild-path]').textContent()) ?? '').trim();
	check("csr=false: header's own $page.url.pathname via $app/stores (the line that crashed)", regionPath === '/split-brain', regionPath);
	check('csr=false: level-2 sibling via $app/state (runes) agrees — no split brain', childPath === '/split-brain', childPath);
	check('csr=false: level-3 leaf via $app/state — mark propagates transitively', grandPath === '/split-brain', grandPath);
	// The RACE guard: SharedUrl is a PLAIN component (not a marked island) imported by SplitHeader
	// (island, csr=false) AND directly by /kit (csr=true). prescan never registers it, so without the
	// eager transitive walk its `$app/*` is marked lazily during Rolldown's walk — order-dependent, the
	// exact shape that broke in production. The walk marks it up front, so it always reads the shim.
	const sharedPath = ((await page.locator('[data-shared-url]').textContent()) ?? '').trim();
	check('csr=false: shared TRANSITIVE dep (also imported by /kit) reads the shim, not the race', sharedPath === '/split-brain', sharedPath);
	// PAGE DATA leg (the bcms all-products crash): `$page.data.<field>.method()` in onMount.
	// Island world: the document seed populates the shim, so the load's value comes through.
	const sharedData = ((await page.locator('[data-shared-data]').textContent()) ?? '').trim();
	check("csr=false: shared component's $page.data via the seeded shim", sharedData === 'islandworld', sharedData);
	const regionErrs = errs.filter((e) => !/favicon/.test(e));
	check('csr=false: zero page errors (the bug threw a TypeError here)', regionErrs.length === 0, regionErrs[0] ?? '');

	// ── csr=true page: the same header renders and reads its own pathname ─────────────────
	// No module-id fork: the header is ONE (shimmed) module. On csr=true the kit-world page thread
	// hands the shim Kit's REAL reactive `page` (url, params, and — the bcms crash — DATA), so the
	// shared copy reads Kit's truth. `$app/state` reads stay live through the thread's getters;
	// `$app/stores` subscribers get a fresh snapshot per notification (island set_page events),
	// which on a Kit page means effectively per-subscription — the documented static-read trade-off.
	const kit = await browser.newPage();
	const kitErrs: string[] = [];
	kit.on('pageerror', (e) => kitErrs.push(e.message));
	await kit.goto(base + '/kit', { waitUntil: 'networkidle' });
	await kit.waitForSelector('[data-split-header]', { timeout: 8000 }).catch(() => {});
	await sleep(300);
	const kitPath = ((await kit.locator('[data-split-path]').textContent()) ?? '').trim();
	check('csr=true: the same header reads its own pathname (/kit)', kitPath === '/kit', kitPath);
	// PAGE DATA leg (the bcms all-products crash, verbatim shape): the shared component calls a
	// method on `$page.data.<field>` in onMount. The island shim starts with `data: {}` and is
	// NEVER seeded on a Kit-booted document — without the kit-page bridge the read returns
	// undefined, the method call throws inside Kit's synchronous hydrate flush, and every
	// component mount after it dies (the bcms header never added `client-mounted`; its CSS cap
	// then clipped the open mega menu). The bridge hands the shim Kit's REAL page data.
	const kitSharedData = ((await kit.locator('[data-shared-data]').textContent()) ?? '').trim();
	check("csr=true: shared component's $page.data reads KIT's real page data", kitSharedData === 'kitworld', kitSharedData);
	const kitFatal = kitErrs.filter((e) => !/favicon/.test(e));
	check('csr=true: zero page errors (the bcms crash threw here)', kitFatal.length === 0, kitFatal[0] ?? '');

	// ── Build output: the header never bundles Kit's real (empty-under-csr=false) client store ──
	// `$app/stores`'s real client reads `getContext('__svelte__')`; on a csr=false island that store
	// is never populated → `page.url` undefined → the crash. With the eager walk the header (and its
	// transitive deps) are shimmed in EVERY chunk that carries them, so none bundle `__svelte__`.
	const clientDir = path.join(repo, 'apps/playground/.svelte-kit/output/client/_app/immutable');
	if (fs.existsSync(clientDir)) {
		const MARKER = 'og-e2e-split-brain';
		const withMarker: string[] = [];
		const walk = (d: string) => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const f = path.join(d, e.name);
				if (e.isDirectory()) walk(f);
				else if (f.endsWith('.js') && fs.readFileSync(f, 'utf-8').includes(MARKER)) {
					withMarker.push(path.relative(clientDir, f));
				}
			}
		};
		walk(clientDir);
		check('build: the header rendered into the client bundle', withMarker.length >= 1, `${withMarker.length} chunk(s)`);
		const leaks: string[] = [];
		for (const rel of withMarker) {
			const chunkPath = path.join(clientDir, rel);
			const closure = [fs.readFileSync(chunkPath, 'utf-8')];
			for (const m of closure[0].matchAll(/import[^'"]*['"](\.[^'"]+\.js)['"]/g)) {
				const dep = path.resolve(path.dirname(chunkPath), m[1]);
				if (fs.existsSync(dep)) closure.push(fs.readFileSync(dep, 'utf-8'));
			}
			if (closure.some((code) => code.includes('__svelte__'))) leaks.push(rel);
		}
		check("build: no copy of the header bundles Kit's real $app/stores (shimmed everywhere)", leaks.length === 0, leaks.join(', ') || 'clean');
	} else {
		check('build: client output exists', false, clientDir);
	}
} finally {
	await browser.close();
}

console.log(out.join('\n'));
if (failures) {
	console.log(`\n${failures} SPLIT-BRAIN CHECK(S) FAILED`);
	process.exit(1);
}
console.log('\nALL SPLIT-BRAIN CHECKS PASSED');
