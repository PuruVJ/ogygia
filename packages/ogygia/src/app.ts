/**
 * Navigation helpers for island components under `csr=false`.
 *
 * Prefer these over `$app/navigation` when calling from island code: Kit's modules
 * are only reliably aliased for imports that land in a virtual island module, while
 * `ogygia/app` is always backed by the ogygia SPA router (on by default, app-wide; opt out
 * with `ogygia({ router: false })`).
 *
 * @packageDocumentation
 */
// One body with the `$app/navigation` shim: the ogygia router on a document ogygia owns, Kit's real
// navigation on a Kit-booted document (shims/app-navigation.ts).
// Island-side: nothing here imports a runtime module — the navigation calls reach the running
// runtime through its navigation handle (runtime/nav-handle.ts), via the shim.
export {
	goto,
	invalidate,
	invalidateAll,
	preloadData,
	preloadCode,
	disableScrollHandling,
	beforeNavigate,
	afterNavigate,
	bust_page_cache
} from './shims/app-navigation.js';
export { spa_html_cacheable } from './runtime/spa-cacheable.js';

export type {
	NavTarget,
	BeforeNavigation,
	AfterNavigation,
	BeforeNavigateCallback,
	AfterNavigateCallback
} from './runtime/router.js';
