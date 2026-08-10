/**
 * `hydratedBy()` — which schedule woke the hydration root this component is mounting under.
 *
 * Call during component SETUP (like `getContext`): the runtime marks the region it is hydrating
 * (the same anchor cross-island context uses), and this reads that region's `hydrate` attribute.
 *
 * Why you'd care: an `interaction` island's first event is a REPLAY — real interaction, but not a
 * trusted browser gesture (`event.isTrusted === false`), so gesture-gated APIs (`window.open`,
 * clipboard, fullscreen) will be blocked for it. A component that needs those can check
 * `hydratedBy() === 'interaction'` and adapt (e.g. render the popup as a link the SECOND click
 * uses, or skip an entrance animation that assumes a fresh load).
 *
 * Returns:
 * - `'load' | 'idle' | 'visible' | 'interaction'` or a media-query string — the region's schedule
 * - `null` on the server (SSR pass), and on csr=true pages where Kit (not ogygia) hydrates.
 *
 * A nested island hydrates with its parent, so it reports the PARENT region's schedule — correct:
 * that is the wake that ran its code.
 */

const CURRENT_REGION = Symbol.for('ogygia.context.current-region');

export function hydratedBy(): string | null {
	if (typeof window === 'undefined') return null;
	const region = (globalThis as Record<symbol, unknown>)[CURRENT_REGION] as Element | null;
	if (!region) return null;
	return region.getAttribute('wake') || 'load';
}
