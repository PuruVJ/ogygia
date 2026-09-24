// THE NAVIGATION HANDLE (runtime/nav-handle.ts): island code reaches the running runtime's navigation
// through `globalThis[Symbol.for('ogygia.nav')]`, never by importing a runtime module. On a document
// ogygia boots it is ALWAYS there: core publishes the MPA handle (the browser navigates; preloads
// become Speculation Rules hints; invalidateAll is still the soft seed refresh), and the router
// feature's install replaces it with the SPA router's API.
import { afterEach, expect, test } from 'vitest';
import { boot } from '../../src/runtime/core.js';
import * as router from '../../src/runtime/router.js';

const NAV = Symbol.for('ogygia.nav');
const scope = globalThis as unknown as Record<symbol, Record<string, unknown> | undefined>;

afterEach(() => {
	document.head.querySelectorAll('script[data-ogygia-speculate-hint]').forEach((s) => s.remove());
});

test('boot without the router publishes the MPA handle; the router feature replaces it with the SPA API', async () => {
	delete scope[NAV];
	boot([]); // a runtime WITHOUT the router feature (`router: false`)
	const mpa = scope[NAV]!;
	expect(mpa, 'core published a handle').toBeDefined();
	expect(mpa.goto, 'not the router’s goto').not.toBe(router.goto);
	// MPA preload: a Speculation Rules hint for the URL (Chromium supports it), resolved as loaded.
	const res = await (mpa.preloadData as (u: string) => Promise<{ type: string }>)('/next-page');
	expect(res.type).toBe('loaded');
	if (HTMLScriptElement.supports?.('speculationrules')) {
		expect(document.head.querySelector('script[data-ogygia-speculate-hint]')?.textContent).toContain('/next-page');
	}
	// goto keeps the router's contract: same-origin only unless `external`.
	expect(() => (mpa.goto as (u: string) => void)('https://elsewhere.example/x')).toThrow(/same-origin/);

	// The router feature installs: its SPA API becomes the handle.
	router.install();
	const spa = scope[NAV]!;
	expect(spa.goto).toBe(router.goto);
	expect(spa.beforeNavigate).toBe(router.beforeNavigate);
	expect(spa.bust_page_cache).toBe(router.bust_page_cache);

	// A later boot never downgrades the router's handle back to the MPA one.
	boot([]);
	expect(scope[NAV]!.goto).toBe(router.goto);
});
