// REGRESSION (field report #3, BUG A): in DEV there is no extracted `.css` asset, so `islandCss`
// hands a region its dev MODULE url as the region-css href. A `<link rel="stylesheet">` to a JS
// module makes an EMPTY sheet (served as text/javascript), so CSS authored in a hole/region silently
// never applied on first load. The runtime must IMPORT such a link's module instead — executing it
// injects the scoped <style> — the same rescue region_fragment runs for a fetched answer, here for
// the links the SSR baked onto the page. Simulated with a data: module that appends a known style.
import { expect, test } from 'vitest';
import { bootDev } from '../../src/runtime/full.js';
import { island_module_url } from '../../src/runtime/region-endpoint-url.js';

// Strips the document's filename so what is left is its directory (for a relative href).
const FILENAME_TAIL_RE = /[^/]*$/;
const MARKER_MODULE = '/test/browser/fixtures/dev-css-marker.ts';

// An ES module evaluates ONCE per url, so a shared marker module cannot prove a SECOND import ran (a
// cache hit re-runs no side effect). Each test that must observe "imported or not" mints its own
// fresh module; the `tag` comment makes the url unique.
const marker_module = (tag: string) =>
	'data:text/javascript,' +
	encodeURIComponent(
		`/* ${tag} */ document.documentElement.setAttribute('data-og-dev-css-marker', '1');`
	);

const MODULE =
	'data:text/javascript,' +
	encodeURIComponent(
		"const s=document.createElement('style');s.setAttribute('data-og-dev-probe','');" +
			"s.textContent='.og-dev-probe{color:rgb(0, 128, 0)}';document.head.appendChild(s);"
	);

function css_link(href: string): void {
	const l = document.createElement('link');
	l.rel = 'stylesheet';
	l.href = href;
	l.setAttribute('data-ogygia-region-css', '');
	document.head.appendChild(l);
}

test('DEV: a region-css link to a JS module is imported (not linked), injecting its <style>', async () => {
	document.head
		.querySelectorAll('link[data-ogygia-region-css], style[data-og-dev-probe]')
		.forEach((n) => n.remove());
	const probe = document.createElement('p');
	probe.className = 'og-dev-probe';
	document.body.appendChild(probe);

	css_link(MODULE); // the inert dev link …
	css_link(MODULE); // … twice, same href — must import ONCE

	bootDev();

	// The module ran: its <style> now colours the probe.
	await expect
		.poll(() => getComputedStyle(probe).color, { timeout: 10_000 })
		.toBe('rgb(0, 128, 0)');
	// The inert links were removed …
	expect(document.head.querySelectorAll('link[data-ogygia-region-css]').length).toBe(0);
	// … and the module executed once, not once per duplicate link.
	expect(document.head.querySelectorAll('style[data-og-dev-probe]').length).toBe(1);

	probe.remove();
});

// REGRESSION (field report #5): the SSR emits region-css hrefs DOCUMENT-relative (`../../@id/…` on a
// nested route — base-aware by design). The rescue used to `import()` that raw href, which resolves
// against the RUNTIME MODULE's url (`/node_modules/…/og-runtime.js` in an app) and 404'd on
// `/node_modules/@id/…`. It must resolve against the document, via island_module_url, like island
// entries do. A relative href to a marker module only imports if resolved against the document.
test('DEV: a document-relative region-css href resolves against the document, not the runtime module', async () => {
	document.head.querySelectorAll('link[data-ogygia-region-css]').forEach((n) => n.remove());
	document.documentElement.removeAttribute('data-og-dev-css-marker');

	// Climb from the document's directory to the root, then down to the marker module.
	const dir = location.pathname.replace(FILENAME_TAIL_RE, '');
	const depth = dir.split('/').filter(Boolean).length;
	const relative = '../'.repeat(depth) + MARKER_MODULE.slice(1);

	// The resolver pins the semantics: against the document, the relative href is the root path.
	expect(island_module_url(relative)).toBe(MARKER_MODULE);

	css_link(relative);
	bootDev();

	// The module ran — only possible if the import resolved against the document.
	await expect
		.poll(() => document.documentElement.getAttribute('data-og-dev-css-marker'), { timeout: 10_000 })
		.toBe('1');
	expect(document.head.querySelectorAll('link[data-ogygia-region-css]').length).toBe(0);
});

// REGRESSION (field report: "scoped <style> never injected in dev"): the rescue must import the link
// for an island that WILL wake on its own, too. An earlier cut skipped those, reasoning the island
// imports its entry at wake — but a `visible` island below the fold, or an `interaction` island nobody
// clicks, may not wake for a long time or ever, and its server-rendered markup sat UNSTYLED meanwhile
// (a hero's min-height collapsing to 0). Prod styles an unwoken island from load; dev matches only by
// executing the module at boot. Front-loaded discovery is moot: island deps are pre-bundled via entries.
test('DEV: a link for an island that will wake is STILL imported at boot — its markup must be styled before wake', async () => {
	document.head.querySelectorAll('link[data-ogygia-region-css]').forEach((n) => n.remove());
	document.documentElement.removeAttribute('data-og-dev-css-marker');
	// `interaction`: zero JS until a pointer/key lands INSIDE it — nothing here will ever wake it, so
	// the boot import is the ONLY way its CSS reaches the page.
	const mod = marker_module('style-before-wake'); // fresh url: only a boot import can run it
	const region = document.createElement('ogygia-region');
	region.setAttribute('entry', mod);
	region.setAttribute('wake', 'interaction');
	document.body.appendChild(region);
	css_link(mod);

	bootDev();

	// The module ran at boot — without any wake.
	await expect
		.poll(() => document.documentElement.getAttribute('data-og-dev-css-marker'), { timeout: 10_000 })
		.toBe('1');
	expect(document.head.querySelectorAll('link[data-ogygia-region-css]').length).toBe(0);
	region.remove();
});

// A lake is frozen — nothing ever imports its entry — so its CSS reaches the page only through the rescue.
test('DEV: a link for a lake (wake="none") is still imported — nothing else would deliver its CSS', async () => {
	document.head.querySelectorAll('link[data-ogygia-region-css]').forEach((n) => n.remove());
	document.documentElement.removeAttribute('data-og-dev-css-marker');
	const mod = marker_module('keep-lake'); // fresh url: a first evaluation, so the side effect is observable
	const lake = document.createElement('ogygia-region');
	lake.setAttribute('entry', mod);
	lake.setAttribute('wake', 'none');
	document.body.appendChild(lake);
	css_link(mod);

	bootDev();

	await expect
		.poll(() => document.documentElement.getAttribute('data-og-dev-css-marker'), { timeout: 10_000 })
		.toBe('1');
	expect(document.head.querySelectorAll('link[data-ogygia-region-css]').length).toBe(0);
	lake.remove();
});
