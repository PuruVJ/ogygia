// Public navigation API for island components (an always-reliable alternative to
// `$app/navigation`, which is only aliased for imports that land directly in an
// island virtual module). Backed by the ogygia SPA router.
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
