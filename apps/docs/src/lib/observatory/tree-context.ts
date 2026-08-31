// Shared state + callbacks for the Observatory file tree, handed from FileTree down to every
// recursive TreeNode. It rides Svelte context (not props) so a deeply nested node reads `active`,
// the collapsed set, and the file callbacks without threading them through every level. The reads
// stay reactive: the ctx object exposes getters over FileTree's `$state`, so a node that reads
// `ctx.active` re-renders when it changes.
import { getContext, setContext } from 'svelte';
import type { SvelteSet } from 'svelte/reactivity';

export type TreeNodeData = {
	name: string;
	path: string;
	kind: 'file' | 'folder';
	children: TreeNodeData[];
};

export interface TreeCtx {
	/** The selected file path (reactive). */
	readonly active: string;
	/** The one file that can't be removed — the render entry (reactive). */
	readonly protectedFile: string;
	/** Which folders are collapsed, by full path. */
	readonly collapsed: SvelteSet<string>;
	onselect: (path: string) => void;
	onremove: (path: string) => void;
	/** Move a file into a folder (drag-and-drop). `toDir` is '' for the workspace root. */
	onmove: (from: string, toDir: string) => void;
	/** Parent directory of a path ('' when the path sits at the root). */
	dir_of: (p: string) => string;
	/** A one-glyph file-type icon. */
	icon: (name: string) => string;
	/** Collapse / expand a folder by path. */
	toggle: (path: string) => void;

	// ── Drop highlight (exactly one winning target) ──
	// neodrag fires `onEnter`/`onLeave` (and thus the wrapper's `isOver`) for EVERY zone the pointer is
	// geometrically inside — so an ancestor root/folder lights up alongside the real target. The engine
	// only ranks ONE winner, surfaced via `onOver`. We record that winner's key here so a single zone
	// highlights; every zone reads `winner` and lights only when it matches.
	readonly winner: string | null;
	/** The currently-winning drop zone announces itself (from its `onOver`). */
	mark_over: (key: string) => void;
	/** A zone clears the highlight when the pointer geometrically leaves it (from its `onLeave`). */
	unmark_over: (key: string) => void;
	/** Belt-and-suspenders: clear any highlight when a drag ends (release anywhere). */
	end_drag: () => void;
}

const KEY = Symbol('obs-tree');
export const set_tree_ctx = (ctx: TreeCtx): TreeCtx => setContext(KEY, ctx);
export const get_tree_ctx = (): TreeCtx => getContext(KEY);
