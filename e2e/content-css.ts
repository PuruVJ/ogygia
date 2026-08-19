// REGRESSION: a content BODY (`.svx`/`.md`) carries its own scoped `<style>`, but the leak-free
// corpus is server-only — its CSS compiles into the SERVER bundle and joins NO page's static
// stylesheet. So on a csr=false doc page the body would render browser-default. ogygia extracts that
// scoped CSS (svelte-compiled from the post-mdsvex source, so `:global` is resolved and the scoped
// hash matches the SSR'd HTML), emits it as a client asset keyed by content_css_key, and Region.svelte
// links it as `<link data-ogygia-region-css>` — the same channel a held dual uses, deduped per-request.
//
// Two guards: (1) the body EMITS its own CSS link (an `og-content.*.css`, the fix's mechanism), and
// (2) the scoped `<style>` actually applies (a distinctive outline, never a browser default).
//
// Usage: node e2e/content-css.ts [baseUrl]
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
	const res = await fetch(base + '/content-css');
	const html = await res.text();
	check('/content-css returns 200', res.status === 200);
	check('/content-css SSR renders the content body', /data-content-css-probe/.test(html));
	// The body's own scoped class is present (svelte-compiled), proving the corpus rendered server-side.
	check('content body is scoped (svelte-<hash>)', /cssprobe svelte-[a-z0-9]+/.test(html));
	// THE FIX: the body's own scoped CSS ships as a hoisted region-css link → a real `og-content.*.css`
	// asset. Absent before the fix (the corpus CSS never left the server bundle).
	const link =
		html.match(/<link\b[^>]*data-ogygia-region-css[^>]*og-content[^>]*>/)?.[0] ||
		html.match(/<link\b[^>]*og-content[^>]*data-ogygia-region-css[^>]*>/)?.[0] ||
		'';
	check(
		'content body emits its own CSS as <link data-ogygia-region-css> (og-content.*.css)',
		/data-ogygia-region-css/.test(link) && /href="[^"]+og-content[^"]+\.css"/.test(link),
		link || 'no content-css link in SSR'
	);
}

// ---------------------------------------------------------------- browser ----
const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	await page.goto(base + '/content-css', { waitUntil: 'networkidle' });
	await page.waitForSelector('[data-content-css-probe]', { timeout: 8000 }).catch(() => {});
	// The distinctive outline colour proves the body's scoped `<style>` is present (unstyled → the
	// browser default, never this rgb).
	const outline = await page
		.locator('[data-content-css-probe]')
		.evaluate((el) => getComputedStyle(el).outlineColor)
		.catch(() => '');
	check('content body: its scoped <style> loaded and applied', outline === 'rgb(11, 197, 141)', outline);
} finally {
	await browser.close();
}

console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL CONTENT-CSS CHECKS PASSED' : failures + ' CONTENT-CSS CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
