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

/**
 * Fragment federation: the FOREIGN island (another build's entry, delegated to its own
 * `__og_hydrate`) the runtime is hydrating right now — or null. The `$app/state` / `$app/stores`
 * shims read this (dev) to warn on a page read: inside a mounted MFE island the page store is the
 * SHELL's document singleton, never the MFE's (its own seed stops at the fragment boundary), so
 * `page.data` there is a repaint mismatch waiting to happen. Same slot discipline as the cursor
 * above — the shell runtime SETS it, the foreign build's shim READS it, one `Symbol.for` slot.
 */
const FOREIGN_HYDRATE = Symbol.for('ogygia.context.foreign-hydrate');

export interface ForeignHydrate {
	/** The MFE origin the island's entry was loaded from. */
	origin: string;
	/** The absolute entry URL — the island's identity for once-per-island warnings. */
	entry: string;
}

/** Runtime marks the foreign island it is about to delegate-hydrate (null when done). */
export function set_foreign_hydrate(info: ForeignHydrate | null) {
	g[FOREIGN_HYDRATE] = info;
}

/** The foreign island currently hydrating (or null) — read by the page shims' dev warning. */
export function foreign_hydrate(): ForeignHydrate | null {
	return (g[FOREIGN_HYDRATE] as ForeignHydrate | null) ?? null;
}
