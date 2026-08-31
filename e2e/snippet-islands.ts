// Islands inside a `{#snippet}` handed to a PLAIN shell that renders it SAME-GRAPH on a csr=false
// page (the ShowcaseCard shape). Two regressions guarded:
//  1. mark preservation — the portable-snippet synth must emit the ORIGINAL `with { wake }` import,
//     so the island placed in the snippet body stays a real `<ogygia-region>` in the entry (a
//     cleaned import demoted it to a plain dead component);
//  2. async threading — the live snippet's server leg renders through the OUTER async renderer
//     (renderer.child), so a top-level `await` in the island body resolves INTO the SSR HTML
//     instead of throwing `await_invalid` (the docs-home 500).
// Usage: node snippet-islands.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}

// ---------- SSR ----------
const res = await fetch(base + '/snippet-islands');
check('SSR: page renders (no await_invalid 500)', res.status === 200, `status=${res.status}`);
const raw = await res.text();

// The snippet rendered through its portable frame…
const frame = raw.match(/<ogygia-snippet[\s\S]*?<\/ogygia-snippet>/)?.[0] ?? '';
check('SSR: portable snippet frame present', frame.length > 0);
// …and the islands inside it are REAL regions (marks survived into the synth entry).
const regions = (frame.match(/<ogygia-region\b/g) ?? []).length;
check('SSR: islands inside the snippet stay regions', regions >= 2, `regions=${regions}`);
// The top-level `await` resolved DURING SSR — its content is in the server HTML.
check('SSR: awaited island content resolved server-side', /data-resolved-greeting/.test(frame) && /Resolved at SSR/.test(frame));
check('SSR: awaited remote data baked in (name crossed)', /in-snippet/.test(frame));
// The interactive island's seed is server-rendered too.
check('SSR: nested interactive island seeded (3)', /data-bumper-n[^>]*>3</.test(frame));
// Each snippet-nested island's entry chunk gets a <head> modulepreload — the portable's inline SSR
// threads its `<svelte:head>` into the document head, so islands forwarded through a PLAIN host are
// discovered early too (not only when a host ISLAND's props carry the descriptor).
const headStr = raw.split('</head>')[0];
const entryHashes = [...frame.matchAll(/entry="([^"]*og-region\.[0-9a-f]+\.js)"/g)].map((m) => m[1]);
const hintedInHead = entryHashes.filter((h) => headStr.includes(`modulepreload" href="${h}"`));
check(
	'SSR: snippet-nested island entries are modulepreloaded in <head>',
	entryHashes.length > 0 && hintedInHead.length === entryHashes.length,
	`${hintedInHead.length}/${entryHashes.length} hinted`
);

// ---------- Browser ----------
const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push('console: ' + m.text());
	});
	await page.goto(base + '/snippet-islands', { waitUntil: 'networkidle' });
	await page.waitForTimeout(250);

	const greeting = page.locator('[data-snippet-stage] [data-resolved-greeting]');
	check('awaited island survives hydration (not wiped)', /in-snippet/.test(await greeting.innerText()));

	const n = page.locator('[data-snippet-stage] [data-bumper-n]');
	check('interactive island seed after hydration', (await n.innerText()) === '3');
	await page.locator('[data-snippet-stage] [data-bumper]').click();
	await page.waitForTimeout(60);
	check('island inside snippet is ALIVE — 3 → 4', (await n.innerText()) === '4', `n=${await n.innerText()}`);

	check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
	await browser.close();
}

console.log('\n' + results.join('\n'));
if (failures) {
	console.error(`\n\x1b[31m${failures} snippet-islands check(s) failed\x1b[0m`);
	process.exit(1);
}
console.log('\n\x1b[32mALL SNIPPET-ISLANDS CHECKS PASSED\x1b[0m');
