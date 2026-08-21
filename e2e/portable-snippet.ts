// Portable snippets — "a snippet is a region". The page hands a named `{#snippet}` to a PLAIN
// (non-island) shell, which forwards it into a hydrate island. A snippet can't cross an island
// boundary as a function, so the compiler compiles its body into a standalone island ENTRY and
// rewrites the value into `og_portable(Entry, captures, url)`. The crossed copy must: render on SSR
// inside the island (captured host value baked in), survive the csr=false hydrate, and come ALIVE —
// the nested island inside the crossed snippet clicks 5 → 6.
// Usage: node portable-snippet.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}

// ---------- SSR ----------
const raw = await (await fetch(base + '/portable-snippet')).text();
// The snippet crossed into the island as a hub ref of kind 'snippet' (not a serialized function).
check('SSR: snippet crosses as a portable snippet ref', /\["OgygiaRef"/.test(raw) && /"snippet"/.test(raw));
// It rendered inside the island's <ogygia-region>, wrapped in the portable container, with the
// captured host value (who = Ada) baked in. Unbounded window: the crossed snippet's nested island
// is now a REAL `<ogygia-region>` (marks survive into the synth entry) + its props script, so the
// bar spans far more than the old 400-char cap.
const barMatch = raw.match(/data-portable-bar[\s\S]*?<\/footer>/);
const bar = barMatch ? barMatch[0] : '';
check('SSR: crossed snippet rendered inside the island bar', /ogygia-snippet/.test(bar));
check('SSR: captured host value crossed (GitHub · Ada)', /GitHub · Ada/.test(bar), bar.slice(0, 120));
check('SSR: nested island inside the crossed snippet seeded (5)', /data-bumper-n[^>]*>5</.test(bar));
// No-waterfall: the portable entry is preloaded in <head>, fetched in parallel with the host island.
check('SSR: portable entry preloaded (no waterfall)', /rel="modulepreload"[^>]*og-region/.test(raw));

// ---------- Browser ----------
const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push('console: ' + m.text());
	});
	await page.goto(base + '/portable-snippet', { waitUntil: 'networkidle' });
	await page.waitForTimeout(250);

	const barGh = page.locator('[data-portable-bar] [data-gh]');
	check('crossed snippet survives hydration (not wiped)', (await barGh.innerText()) === 'GitHub · Ada');

	const barBumper = page.locator('[data-portable-bar] [data-bumper-n]');
	check('nested island seed inside crossed snippet', (await barBumper.innerText()) === '5');
	await page.locator('[data-portable-bar] [data-bumper]').click();
	await page.waitForTimeout(60);
	check(
		'crossed snippet is ALIVE — nested island 5 → 6',
		(await barBumper.innerText()) === '6',
		`n=${await barBumper.innerText()}`
	);

	check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
	await browser.close();
}

console.log('\n' + results.join('\n'));
if (failures) {
	console.error(`\n\x1b[31m${failures} portable-snippet check(s) failed\x1b[0m`);
	process.exit(1);
}
console.log('\n\x1b[32mALL PORTABLE-SNIPPET CHECKS PASSED\x1b[0m');
