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
