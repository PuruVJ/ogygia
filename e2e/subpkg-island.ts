// REGRESSION: an island HOST that lives in a workspace sub-package which does NOT depend on ogygia
// (`internal/repro-subpkg`, imported by the playground at /subpkg-island). The ogygia transform
// injects `ogygia/internal` / `ogygia/internal/server` into that host + its generated island module;
// a bare specifier would resolve from the sub-package (no ogygia there) and the BUILD would fail:
//   Rolldown failed to resolve import "ogygia/internal" from ".../repro-subpkg/.../Toolbar.svelte"
// The plugin re-bases those injected imports off ogygia's OWN package (PKG_ROOT self-reference), so
// the build succeeds AND the island hydrates. If this file's page even SSRs, the build already passed
// the resolution; the click proves the island came alive.
// Usage: node e2e/subpkg-island.ts [baseUrl]
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
	// SSR: the sub-package island rendered → the build resolved the injected ogygia imports.
	const raw = await (await fetch(base + '/subpkg-island')).text();
	check('SSR: sub-package island host rendered', /data-subpkg-toolbar/.test(raw));
	check('SSR: sub-package island present', /data-subpkg-island/.test(raw));

	const page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push('console: ' + m.text());
	});
	await page.goto(base + '/subpkg-island', { waitUntil: 'networkidle' });
	await page.waitForTimeout(250);

	const btn = page.locator('[data-subpkg-island]');
	check('island present after hydrate', (await btn.count()) === 1);
	const before = await btn.innerText();
	await btn.click();
	await page.waitForTimeout(80);
	const after = await btn.innerText();
	check('sub-package island HYDRATED (click increments)', before !== after && /1/.test(after), `${before} -> ${after}`);
	check('no page errors / hydration mismatches', errors.length === 0, errors.join(' | '));
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL SUBPKG-ISLAND CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
