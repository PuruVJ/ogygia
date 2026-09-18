// REGRESSION (field report #3, BUG A): in DEV there is no extracted `.css` asset, so `islandCss`
// hands a region its dev MODULE url as the region-css href. A `<link rel="stylesheet">` to a JS
// module makes an EMPTY sheet (served as text/javascript), so CSS authored in a hole/region silently
// never applied on first load. The runtime must IMPORT such a link's module instead — executing it
// injects the scoped <style> — the same rescue region_fragment runs for a fetched answer, here for
// the links the SSR baked onto the page. Simulated with a data: module that appends a known style.
import { expect, test } from 'vitest';
import { bootDev } from '../../src/runtime/full.js';

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
