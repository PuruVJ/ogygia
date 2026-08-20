// asRegion — `import.meta.og.asRegion(Comp, timing)` marks a NAMED / barrel import as a placed
// island (the macro alternative to `import X with { wake }`, which is default-import-only). Proves
// three things against the built playground /as-region page:
//   1. both barrel components SSR + hydrate (Ticker wake:'load', Flag wake:'visible'),
//   2. a NON-component barrel export (brandConfig) still works as an ordinary value in the shell,
//   3. TREE-SHAKING — the unused barrel exports (a heavy component + a huge constant) never reach the
//      client build, so an island off a huge barrel ships lean, not the whole barrel.
//
// Usage: node e2e/as-region.ts [baseUrl]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	if (!cond) failures++;
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 1 + 2. browser: SSR + hydration + mixed barrel export ────────────────────────────────────────
const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
	const errs: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error') errs.push(m.text());
	});
	page.on('pageerror', (e) => errs.push(String(e)));
	await page.goto(base + '/as-region', { waitUntil: 'networkidle' });

	// Ticker — wake:'load' → hydrates immediately.
	const ticker = page.locator('[data-ticker] button').first();
	await ticker.waitFor();
	check('asRegion: ticker SSR prop (start=10)', (await ticker.textContent())!.includes('ticks 10'));
	await ticker.click();
	await ticker.click();
	check(
		'asRegion: ticker (wake:load) hydrated + interactive',
		(await ticker.textContent())!.includes('ticks 12'),
		(await ticker.textContent())!
	);

	// Flag — wake:'visible' → hydrates once scrolled into view.
	const flag = page.locator('[data-flag] button').first();
	await flag.waitFor();
	check('asRegion: flag SSR prop (on=true)', (await flag.textContent())!.includes('flag is ON'));
	await flag.scrollIntoViewIfNeeded();
	await sleep(300);
	await flag.click();
	check(
		'asRegion: flag (wake:visible) hydrated + interactive',
		(await flag.textContent())!.includes('flag is OFF'),
		(await flag.textContent())!
	);

	// A NON-component export from the SAME barrel, used as an ordinary value in the shell.
	check(
		'asRegion: non-component barrel export used in shell',
		(await page.locator('[data-brand]').textContent())!.includes('Acme Islands')
	);

	check('asRegion: no console errors', errs.length === 0, errs.join(' | '));
} finally {
	await browser.close();
}

// ── 3. build-output: tree-shaking canaries must be ABSENT from the client build ────────────────────
const clientDir = path.join(repo, 'apps/playground/.svelte-kit/output/client');
function clientContains(marker: string): string[] {
	const hits: string[] = [];
	const walk = (d: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const f = path.join(d, e.name);
			if (e.isDirectory()) walk(f);
			else if (f.endsWith('.js') && fs.readFileSync(f, 'utf-8').includes(marker)) hits.push(path.relative(clientDir, f));
		}
	};
	walk(clientDir);
	return hits;
}
if (fs.existsSync(clientDir)) {
	const hugeHits = clientContains('ogygia_barrel_huge_unused_canary');
	check('asRegion: huge unused barrel constant tree-shaken (absent from client)', hugeHits.length === 0, hugeHits.join(', '));
	const compHits = clientContains('ogygia_barrel_heavy_component_canary');
	check('asRegion: unused barrel component tree-shaken (absent from client)', compHits.length === 0, compHits.join(', '));
} else {
	check('asRegion: client build present for tree-shake inspection', false, `missing ${clientDir}`);
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL asRegion CHECKS PASSED' : failures + ' asRegion CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
