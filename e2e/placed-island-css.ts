// REGRESSION: a PLACED client island's own CSS must load on the page it renders on.
//
// Kit links a route's STATIC import graph, but Rollup can chunk-split a `wake`-marked component's
// CSS — notably its `:global()` rules (a Bits UI dropdown trigger/menu, a scoped card) — into a
// chunk the page never loads, so the island renders browser-default in a production build. The
// design assumed a plain island's CSS was "already in the page's own stylesheet"; chunk-splitting
// violates that. Region.svelte now ships each placed island's own CSS as `<link
// data-ogygia-region-css>` (the same channel a held dual uses, deduped per-request).
//
// Two guards: (1) the placed island EMITS its CSS link (the fix's mechanism — deterministic
// regardless of whether the CSS happened to split), and (2) the `:global()` style actually applies.
//
// Usage: node e2e/placed-island-css.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

// ---------------------------------------------------------------- fetch/SSR --
{
	const res = await fetch(base + '/placed-island-css');
	const html = await res.text();
	check('/placed-island-css returns 200', res.status === 200);
	check('/placed-island-css ships NO Kit bootstrap (csr=false)', !/__sveltekit/.test(html));
	check('/placed-island-css SSR has the placed island region', /<ogygia-region\b/.test(html));
	// THE FIX: the placed island's own CSS ships as a hoisted region-css link → a real `.css` in a
	// production build. Absent before the fix (region_css_html only fired for held duals).
	const link = html.match(/<link\b[^>]*data-ogygia-region-css[^>]*>/)?.[0] || '';
	check(
		'placed island emits its own CSS as <link data-ogygia-region-css>',
		/data-ogygia-region-css/.test(link) && /href="[^"]+\.css"/.test(link),
		link || 'no region-css link in SSR'
	);
}

// ---------------------------------------------------------------- browser ----
const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	await page.goto(base + '/placed-island-css', { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('[data-css-probe]', { timeout: 8000 }).catch(() => {});
	// The distinctive outline colour proves the island's `:global()` CSS is present (unstyled → the
	// browser default `rgb(0, 0, 0)` / transparent, never this rgb).
	const outline = await page
		.locator('[data-css-probe]')
		.evaluate((el) => getComputedStyle(el).outlineColor)
		.catch(() => '');
	check('placed island: its :global() CSS loaded and applied', outline === 'rgb(9, 176, 84)', outline);
} finally {
	await browser.close();
}

console.log(out.join('\n'));
console.log(
	`\n${failures === 0 ? 'ALL PLACED-ISLAND-CSS CHECKS PASSED' : failures + ' PLACED-ISLAND-CSS CHECK(S) FAILED'}`
);
process.exit(failures === 0 ? 0 : 1);
