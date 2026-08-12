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
export {
	goto,
	invalidate,
	invalidateAll,
	preloadData,
	preloadCode,
	beforeNavigate,
	afterNavigate,
	disableScrollHandling,
	bust_page_cache,
	spa_html_cacheable
} from './runtime/router.js';

export type {
	NavTarget,
	BeforeNavigation,
	AfterNavigation,
	BeforeNavigateCallback,
	AfterNavigateCallback
} from './runtime/router.js';
