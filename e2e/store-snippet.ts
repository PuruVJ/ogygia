// Store auto-subscriptions in a crossing snippet — the consumer CI regression. A `{#snippet}`
// handed to a hydrate island reads `$country` / `$language` (bare, member chain, template
// literal). The compiler must hoist the subscription VALUES at the host and rewrite the crossed
// body — the old behavior emitted `$country` verbatim into the runes-mode synth entry and the
// BUILD died inside virtual:ogygia/island/… (so this page building at all is half the test).
// The crossed copy must render the snapshot on SSR, survive hydration, and stay alive.
// Usage: node store-snippet.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}

// ---------- SSR ----------
const raw = await (await fetch(base + '/store-snippet')).text();
check('SSR: page built + served (the regression WAS a build failure)', /data-static/.test(raw));
// The host's own read still works (store sugar untouched outside the crossing).
check('SSR: host-scope $store read intact', /host reads fr directly/.test(raw));
// The crossed snippet rendered the SNAPSHOT values inside the island bar.
const barMatch = raw.match(/data-portable-bar[\s\S]*?<\/footer>/);
const bar = barMatch ? barMatch[0] : '';
check('SSR: bare $country crossed as its value', /data-cc[^>]*>fr</.test(bar), bar.slice(0, 160));
check('SSR: template-literal + member chain crossed (en-FR)', /data-loc[^>]*>locale: en-FR</.test(bar));
check('SSR: nested island inside the crossed snippet seeded (7)', /data-bumper-n[^>]*>7</.test(bar));
// The capture rides the wire under its rewritten prop name, with the VALUE, not the store.
check('SSR: capture prop __og_sub_country in payload', /__og_sub_country/.test(raw));
check('SSR: no verbatim $-identifier leaked into payload/markup', !/\$country/.test(raw), 'found $country');

// ---------- Browser ----------
const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push('console: ' + m.text());
	});
	await page.goto(base + '/store-snippet', { waitUntil: 'networkidle' });
	await page.waitForTimeout(250);

	const cc = page.locator('[data-portable-bar] [data-cc]');
	check('snapshot survives hydration (fr)', (await cc.innerText()) === 'fr');
	const loc = page.locator('[data-portable-bar] [data-loc]');
	check('composed snapshot survives hydration (locale: en-FR)', (await loc.innerText()) === 'locale: en-FR');

	const barBumper = page.locator('[data-portable-bar] [data-bumper-n]');
	check('nested island seed inside crossed snippet', (await barBumper.innerText()) === '7');
	await page.locator('[data-portable-bar] [data-bumper]').click();
	await page.waitForTimeout(60);
	check(
		'crossed snippet is ALIVE — nested island 7 → 8',
		(await barBumper.innerText()) === '8',
		`n=${await barBumper.innerText()}`
	);

	check('no page errors (incl. hydration mismatch)', errors.length === 0, errors.join(' | '));
} finally {
	await browser.close();
}

console.log('\n' + results.join('\n'));
if (failures) {
	console.error(`\n\x1b[31m${failures} store-snippet check(s) failed\x1b[0m`);
	process.exit(1);
}
console.log('\n\x1b[32mALL STORE-SNIPPET CHECKS PASSED\x1b[0m');
