// Client-side shim for `$app/navigation` inside islands.
// Delegates to the ogygia SPA router. Aliased only in the client build.
export {
	goto,
	invalidate,
	invalidateAll,
	preloadData,
	preloadCode,
	beforeNavigate,
	afterNavigate,
	disableScrollHandling,
	pushState,
	replaceState
} from '../runtime/router.js';

// `onNavigate` (view-transition hook) — accept + no-op (VT already handled by router).
export function onNavigate() {
	return () => {};
}

// `goto` needs to exist; `preloadData`/`preloadCode` differ from Kit (see README).
