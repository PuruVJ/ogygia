// REGRESSION: the production `$app/stores` split brain, reproduced end to end.
//
// The shape (seen live on a deployed ogygia 0.5.1 app): a Header island whose FIRST import is
// `$app/stores`, siblings importing the same module LATER in the list, and the same file also
// imported PLAIN by a csr=true page. Under lazy island-graph membership, build order decided
// which `$app/*` each copy got: the header bundled Kit's REAL client store — whose page store
// never populates under csr=false — while its siblings got the shim. `$page.url.pathname` threw
// "Cannot read properties of undefined (reading 'pathname')" during hydrate and the header was
// torn out of the page. `?og-region` identity makes membership ride in the module id, so the
// region copy ALWAYS gets the shim and the csr=true copy ALWAYS keeps Kit's real store.
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
	const regionErrs = errs.filter((e) => !/favicon/.test(e));
	check('csr=false: zero page errors (the bug threw a TypeError here)', regionErrs.length === 0, regionErrs[0] ?? '');

	// ── Kit world: the SAME file plain-imported on the csr=true page keeps the REAL store ─
	const kit = await browser.newPage();
	const kitErrs: string[] = [];
	kit.on('pageerror', (e) => kitErrs.push(e.message));
	await kit.goto(base + '/kit', { waitUntil: 'networkidle' });
	await kit.waitForSelector('[data-split-header]', { timeout: 8000 }).catch(() => {});
	await sleep(300);
	const kitPath = ((await kit.locator('[data-split-path]').textContent()) ?? '').trim();
	check("csr=true: plain copy renders Kit's real $page.url.pathname", kitPath === '/kit', kitPath);
	const kitFatal = kitErrs.filter((e) => !/favicon/.test(e));
	check('csr=true: zero page errors', kitFatal.length === 0, kitFatal[0] ?? '');

	// ── Build output: two worlds, and the region world is Kit-store-free ─────────────────
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
		const regionCopies = withMarker.filter((f) => !f.startsWith('nodes/'));
		const kitCopies = withMarker.filter((f) => f.startsWith('nodes/'));
		check('build: exactly one region-world copy of the header', regionCopies.length === 1, regionCopies.join(', ') || '(none)');
		check('build: the csr=true page owns its own Kit-world copy', kitCopies.length >= 1, kitCopies.join(', ') || '(none)');

		// Kit's real `$app/stores` reads `getContext('__svelte__')` and drags in Kit's client
		// router — the exact leak seen in production. The region copy's chunk and its DIRECT
		// static imports must be free of it. (`nodes/` copies legitimately reach it via Kit.)
		if (regionCopies.length === 1) {
			const regionChunkPath = path.join(clientDir, regionCopies[0]);
			const regionCode = fs.readFileSync(regionChunkPath, 'utf-8');
			const closure = [regionCode];
			for (const m of regionCode.matchAll(/import[^'"]*['"](\.[^'"]+\.js)['"]/g)) {
				const dep = path.resolve(path.dirname(regionChunkPath), m[1]);
				if (fs.existsSync(dep)) closure.push(fs.readFileSync(dep, 'utf-8'));
			}
			check(
				"build: region world never bundles Kit's real $app/stores",
				closure.every((code) => !code.includes('__svelte__')),
				`${closure.length} files checked`
			);
		}
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
