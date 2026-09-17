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
export {
	goto,
	invalidate,
	invalidateAll,
	preloadData,
	preloadCode,
	disableScrollHandling,
	beforeNavigate,
	afterNavigate
} from './shims/app-navigation.js';
export { bust_page_cache, spa_html_cacheable } from './runtime/router.js';

export type {
	NavTarget,
	BeforeNavigation,
	AfterNavigation,
	BeforeNavigateCallback,
	AfterNavigateCallback
} from './runtime/router.js';
