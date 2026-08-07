import { createContext } from 'svelte';
import { getRequestEvent } from 'virtual:ogygia/request-event';

// Type-safe context (Svelte 5.40+ `createContext`) marking "this subtree is already inside a
// hydrated island". Nested island wrappers read it and degrade to a plain inline component so
// an island-within-an-island hydrates exactly once, together with its parent.
const [get_nested_context, set_nested_context] = createContext<boolean>();

/**
 * Mark the current subtree's hydration state. `true` = inside a hydrated island (nested islands
 * degrade). `false` = a LAKE resets its subtree to "dead", so an island inside the lake self-
 * hydrates again (the nearest-boundary rule — DESIGN.md).
 */
export function setNested(value = true): void {
	set_nested_context(value);
}

/**
 * True when an ancestor island wrapper already marked the subtree. `createContext`'s getter
 * throws when no ancestor set it (a top-level island) — that absence is exactly "not nested".
 */
export function isNested(): boolean {
	try {
		return get_nested_context() === true;
	} catch {
		return false;
	}
}

/** Per-request: only one `data-ogygia-runtime` script should be emitted (router, else first island). */
const runtime_claimed = new WeakMap<object, true>();

/**
 * Claim the single runtime-script slot for this SSR request.
 * OgygiaRouter claims first when present; islands/server-islands only emit if this returns true
 * (pages with no router). Client / no-request → false (SSR already emitted).
 */
export function claimRuntimeEmit(): boolean {
	try {
		const event = getRequestEvent() as object;
		if (runtime_claimed.has(event)) return false;
		runtime_claimed.set(event, true);
		return true;
	} catch {
		return false;
	}
}
