/**
 * Site-wide tab-group memory. Every `<TabGroup group="...">` with the same `group` shares one
 * selected label — pick "pnpm" in one block and every `group="install"` block on the page follows —
 * and the choice persists across pages (localStorage). A single module-level reactive record backs it,
 * so all blocks (and all island instances, which re-hydrate per nav) read and write the same state.
 *
 * This is the runes-module (`*.svelte.ts`) half of TabGroup: the component owns the Bits UI markup and
 * keyboard behavior; this owns the shared choice.
 */

const KEY = 'og-tabs:';

// group id → selected label. `$state` in a `.svelte.ts` module is a genuine reactive singleton: the
// build emits it as `.svelte.js` with the rune intact, and every importer shares this one record.
const selected = $state<Record<string, string>>({});

/** A reactive handle for one group's selected label. Setting it persists to localStorage. */
export function tab_group(group: string) {
	return {
		get value(): string | undefined {
			return selected[group];
		},
		set value(label: string) {
			selected[group] = label;
			try {
				localStorage.setItem(KEY + group, label);
			} catch {
				/* private mode — memory-only is fine */
			}
		}
	};
}

/**
 * Seed a group's initial choice ONCE, from localStorage if present, else `fallback` (the first tab's
 * label). Client-only and idempotent: call it on mount, after the first paint, so restoring a saved
 * choice is a post-hydration update (no SSR/client mismatch) rather than an initial-render divergence.
 */
export function hydrate_group(group: string, fallback: string): void {
	if (selected[group] != null) return; // already chosen this session — don't clobber
	let saved: string | null = null;
	try {
		saved = localStorage.getItem(KEY + group);
	} catch {
		/* private mode */
	}
	selected[group] = saved ?? fallback;
}
