/**
 * The region the runtime is currently hydrating — the DOM anchor cross-island `context.get()` walks
 * up from. It lives ALONE, with zero heavy imports, on purpose: `core` needs only to SET it while
 * hydrating, and pulling it from `context-bridge` used to drag the whole codec + `svelte/server`
 * graph into every client bundle. Kept on `globalThis` under a `Symbol.for` key so the runtime and
 * the (separately-bundled) context feature agree on one slot. See INVARIANTS · CONTEXT-CURSOR.
 */
const CURRENT_REGION = Symbol.for('ogygia.context.current-region');
const g = globalThis as Record<symbol, unknown>;

/** Runtime sets the region it is about to hydrate so a nested `get()` knows where to start walking. */
export function set_current_region(el: Element | null) {
	g[CURRENT_REGION] = el;
}

/** The region currently being hydrated (or null) — read by the context feature's client DOM walk. */
export function current_region(): Element | null {
	return (g[CURRENT_REGION] as Element | null) ?? null;
}
