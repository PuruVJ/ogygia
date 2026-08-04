import { createContext } from 'svelte';

// Type-safe context (Svelte 5.40+ `createContext`) marking "this subtree is already inside a
// hydrated island". Nested island wrappers read it and degrade to a plain inline component so
// an island-within-an-island hydrates exactly once, together with its parent.
const [get_nested_context, set_nested_context] = createContext<boolean>();

/** Mark the current subtree as living inside an island (called by a top-level wrapper/provider). */
export function setNested(): void {
	set_nested_context(true);
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
