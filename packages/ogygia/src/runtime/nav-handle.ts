/**
 * THE NAVIGATION HANDLE — how ISLAND-SIDE code (the `$app/navigation` shim, `ogygia/app`, the
 * remote-functions client stub, the lifecycle hooks) reaches the running runtime's navigation
 * WITHOUT importing a runtime module.
 *
 * Why not just import the router: island code is bundled apart from the runtime (an island chunk
 * can load on a csr=true page where the runtime never boots). A runtime module island code imports
 * is SHARED between the two graphs, so the bundler must keep it out of the runtime chunk — and with
 * it everything that module's own lazy chunks need. One `import … from '../runtime/router.js'` in the
 * navigation shim split the runtime's boot into a dozen files. So island code reads this handle
 * from the global realm (the same pattern as the Kit page bridge, `Symbol.for('ogygia.kit-page')`),
 * and `test/runtime-boot-svelte-free.test.ts` pins that no island-side module imports a boot module.
 *
 * Who publishes it, always, on a document ogygia boots:
 * - the ROUTER feature (./router.ts `install`) — the SPA router's API;
 * - otherwise core (`boot`) publishes {@link mpa_nav}: the browser navigates, preloads become
 *   Speculation Rules hints, and `invalidateAll` is still the soft seed refresh (./router-nav.ts,
 *   loaded on first use) — exactly what `router: false` apps got before.
 *
 * Island code reads it as `globalThis[Symbol.for('ogygia.nav')]` (the key is repeated there on
 * purpose: importing {@link NAV_HANDLE_KEY} would be the very edge this module exists to avoid).
 */
import { speculate_url } from './speculate-hint.js';
import type { AfterNavigateCallback, BeforeNavigateCallback } from './router.js';

export const NAV_HANDLE_KEY = Symbol.for('ogygia.nav');

export type NavHandle = {
	goto(url: string | URL, opts?: { replaceState?: boolean; external?: boolean }): Promise<void>;
	invalidate(): Promise<void>;
	invalidateAll(): Promise<void>;
	preloadData(url: string | URL): Promise<unknown>;
	preloadCode(url?: string | URL): Promise<void>;
	disableScrollHandling(): void;
	pushState(): void;
	replaceState(): void;
	beforeNavigate(fn: BeforeNavigateCallback): () => void;
	afterNavigate(fn: AfterNavigateCallback): () => void;
	bust_page_cache(): void;
};

/** Publish the document's navigation handle (the router's replaces the MPA one). */
export function publish_nav(handle: NavHandle): void {
	(globalThis as unknown as Record<symbol, NavHandle>)[NAV_HANDLE_KEY] = handle;
}

const NO_UNSUBSCRIBE = () => {};

/**
 * The handle when the router feature is not in this runtime (`router: false`): the browser owns
 * navigation. Same contract the router's own functions had for that case.
 */
export function mpa_nav(): NavHandle {
	return {
		goto(url, opts = {}) {
			const target = new URL(url, location.href);
			if (target.protocol !== 'http:' && target.protocol !== 'https:') {
				throw new Error('[ogygia] goto() only supports http(s) URLs');
			}
			if (target.origin !== location.origin && !opts.external) {
				throw new Error(
					'[ogygia] goto() only supports same-origin URLs (pass { external: true } to leave)'
				);
			}
			if (opts.replaceState) location.replace(target.href);
			else location.assign(target.href);
			return Promise.resolve();
		},
		// No SPA cache to bust, but the page's seeds can still refresh in place.
		invalidate: () => import('./router-nav.js').then((n) => n.invalidate_all()),
		invalidateAll: () => import('./router-nav.js').then((n) => n.invalidate_all()),
		preloadData(url) {
			speculate_url(url, 'prerender');
			return Promise.resolve({ type: 'loaded' as const, status: 200, data: {} });
		},
		preloadCode(url) {
			if (url != null) speculate_url(url, 'prefetch');
			return Promise.resolve();
		},
		disableScrollHandling() {},
		pushState() {
			console.warn('[ogygia] pushState() shallow routing is not supported; use goto().');
		},
		replaceState() {
			console.warn('[ogygia] replaceState() shallow routing is not supported; use goto().');
		},
		// No client-side navigations happen without the router: nothing to notify.
		beforeNavigate: () => NO_UNSUBSCRIBE,
		afterNavigate: () => NO_UNSUBSCRIBE,
		bust_page_cache() {}
	};
}
