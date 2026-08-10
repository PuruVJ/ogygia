// Cross-island composition: a host page composes a hydrate island from the OUTSIDE — default
// children, a captured host value, a named snippet, a parameterized snippet, and a NESTED ISLAND —
// and the compiler ships them all as a synthesized entry. Everything must render on SSR, survive
// the csr=false hydrate (no wipe / mismatch), and stay interactive (parent toggle + nested island).
// Usage: node verify/island-children.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}

// ---------- SSR ----------
const raw = await (await fetch(base + '/island-children')).text();
// Two CardShell call sites → two regions; the nested Bumper degrades inline (would be 3 otherwise).
check('SSR: one region per call site, nested island degrades inline', (raw.match(/ogygia-region entry="/g) || []).length === 2, `regions=${(raw.match(/ogygia-region entry="/g) || []).length}`);
check('SSR: captured value in named snippet', /data-child-header[^>]*>header for Ada/.test(raw));
check('SSR: default children with captured value', /data-child-static[^>]*>hello Ada/.test(raw));
check('SSR: parameterized snippet rendered by the island', (raw.match(/data-child-row[^>]*>(one|two) · Ada/g) || []).length === 2);
check('SSR: nested island seeded (bumper=5)', /data-bumper-n[^>]*>5</.test(raw));

// ---------- Browser ----------
const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push('console: ' + m.text());
	});
	await page.goto(base + '/island-children', { waitUntil: 'networkidle' });
	await page.waitForTimeout(250);

	check('children survive hydration (not wiped)', (await page.locator('[data-child-static]').innerText()) === 'hello Ada');
	check('named snippet survives hydration', (await page.locator('[data-child-header]').innerText()) === 'header for Ada');
	check('param snippet survives hydration', (await page.locator('[data-child-row]').count()) === 2);

	// Nested island B is interactive (degraded → hydrated with A)
	check('nested island seed', (await page.locator('[data-bumper-n]').innerText()) === '5');
	await page.locator('[data-bumper]').click();
	await page.waitForTimeout(50);
	check('nested island B is live (5 → 6)', (await page.locator('[data-bumper-n]').innerText()) === '6', `n=${await page.locator('[data-bumper-n]').innerText()}`);

	// Parent island A is live and gates the crossed children
	await page.locator('[data-card-toggle]').first().click();
	await page.waitForTimeout(50);
	check('parent island A live: toggle hides crossed children', (await page.locator('[data-child-static]').count()) === 0);
	await page.locator('[data-card-toggle]').first().click();
	await page.waitForTimeout(50);
	check('parent island A live: toggle restores crossed children', (await page.locator('[data-child-static]').count()) === 1);

	// Per-call-site: a SECOND usage of the same import with different children is its own island.
	check('second call site of the same import renders its own children', (await page.locator('[data-child-second]').innerText()) === 'second card, Ada');

	check('no page errors / hydration mismatch', errors.length === 0, errors.join(' | '));
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL ISLAND-CHILDREN CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
