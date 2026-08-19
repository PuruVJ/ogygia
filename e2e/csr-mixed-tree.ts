// REGRESSION: csr-true context inheritance across a mixed route tree. An option-less (or explicit)
// csr=true ANCESTOR layout injects the csr-true context marker; Svelte context flows to ALL
// descendants, so before the csr-false RESET marker existed, every island in a `csr = false` CHILD
// subtree read `true` (isCsrTrue) and silently degraded to inline — zero <ogygia-region>, no
// hydration, no onMount (se-web-platform /fr/fr/ root cause). Routes: /mixed-root (csr=true host) →
// /mixed-root/sub (csr=false subtree with a wake:'load' island in its layout).
// Usage: node e2e/csr-mixed-tree.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}

// Count real <ogygia-region elements (not the string in CSS/scripts).
const region_count = (html: string) => (html.match(/<ogygia-region\b/g) ?? []).length;

const browser = await chromium.launch();
try {
	// SSR: the csr=false subtree under the csr=true ancestor emits REAL regions…
	const sub = await (await fetch(base + '/mixed-root/sub')).text();
	check('csr=false subtree: <ogygia-region> emitted under csr=true ancestor', region_count(sub) >= 1, `count=${region_count(sub)}`);
	// …and the csr=true level emits none (Kit owns it).
	const top = await (await fetch(base + '/mixed-root')).text();
	check('csr=true ancestor level: zero <ogygia-region>', region_count(top) === 0, `count=${region_count(top)}`);

	const page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push('console: ' + m.text());
	});
	await page.goto(base + '/mixed-root/sub', { waitUntil: 'networkidle' });
	await page.waitForTimeout(300);

	const btn = page.locator('[data-dyn-island]');
	check('island present after hydrate', (await btn.count()) === 1);
	const before = await btn.innerText();
	await btn.click();
	await page.waitForTimeout(80);
	const after = await btn.innerText();
	check('island HYDRATED in csr=false subtree (click increments)', before !== after && /1/.test(after), `${before} -> ${after}`);
	check('island onMount ran', (await page.evaluate(() => (window as unknown as { __dynMounted?: number }).__dynMounted)) === 1);
	check('no page errors / hydration mismatches', errors.length === 0, errors.join(' | '));
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL CSR-MIXED-TREE CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
