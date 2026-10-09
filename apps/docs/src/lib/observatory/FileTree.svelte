<script lang="ts">
	// The Observatory's file tree (left pane). Builds a folder tree from the file map's keys — a key is
	// a path, so `src/lib/Counter.svelte` nests under src › lib, while a bare `App.svelte` sits at the
	// root. Backward-compatible: flat presets (no `/`) render as a flat list. Folders collapse; files
	// select + remove. Rows and their drag-and-drop live in the recursive <TreeNode>; this component
	// owns the workspace-root drop zone and hands shared state down via context.
	import { SvelteSet } from 'svelte/reactivity';
	import { Droppable, type DropAcceptCtx, type DropEventData } from '@neodrag/svelte/drop';
	import TreeNode from './TreeNode.svelte';
	import { set_tree_ctx, type TreeNodeData } from './tree-context';
	type FileMap = Record<string, string>;

	let {
		files,
		active,
		entry,
		onselect,
		onremove,
		onadd,
		onmove,
		oncollapse
	}: {
		files: FileMap;
		active: string;
		entry: string;
		onselect: (path: string) => void;
		onremove: (path: string) => void;
		onadd: () => void;
		/** Move a file into a folder (drag-and-drop). `toDir` is '' for the workspace root. */
		onmove?: (from: string, toDir: string) => void;
		oncollapse?: () => void;
	} = $props();

	const dir_of = (p: string): string => {
		const i = p.lastIndexOf('/');
		return i < 0 ? '' : p.slice(0, i);
	};

	// The single winning drop target's key (see tree-context). Root's key is a sentinel that can't
	// collide with any file/folder key (those are `kind:path`).
	const ROOT_KEY = 'root';
	let winner = $state<string | null>(null);

	// The workspace root is itself a drop zone: dropping a nested file onto empty tree space (below the
	// rows) moves it to the root. Lowest priority — any folder/file row under the pointer wins first.
	const rootDrop = new Droppable({
		collision: 'pointer',
		priority: 0,
		get accepts() {
			return (c: DropAcceptCtx): boolean => typeof c.data === 'string' && dir_of(c.data) !== '';
		},
		onOver: () => (winner = ROOT_KEY),
		onLeave: () => {
			if (winner === ROOT_KEY) winner = null;
		},
		onDrop: (e: DropEventData) => {
			winner = null;
			if (typeof e.data === 'string') onmove?.(e.data, '');
		}
	});

	// Which folders are collapsed (by full path). Default: everything expanded — a codebase you just
	// opened should show itself. Collapsing is opt-in and remembered while the workspace is loaded.
	let collapsed = $state(new SvelteSet<string>());

	// The row snippet renders RECURSIVELY (one call per folder level), so a pathological key with
	// hundreds of `/` segments would overflow the call stack. Cap the tree depth: overflow segments
	// collapse into the leaf's name. No real workspace nests this deep; a hostile/shared one can't
	// crash the tree.
	const MAX_TREE_DEPTH = 12;
	function build(map: FileMap): TreeNodeData {
		const root: TreeNodeData = { name: '', path: '', kind: 'folder', children: [] };
		for (const key of Object.keys(map)) {
			let parts = key.split('/').filter(Boolean);
			if (parts.length > MAX_TREE_DEPTH)
				parts = [...parts.slice(0, MAX_TREE_DEPTH - 1), parts.slice(MAX_TREE_DEPTH - 1).join('/')];
			let node = root;
			let sofar = '';
			for (let i = 0; i < parts.length; i++) {
				const part = parts[i];
				sofar = sofar ? `${sofar}/${part}` : part;
				const isFile = i === parts.length - 1;
				let child = node.children.find(
					(c) => c.name === part && (isFile ? c.kind === 'file' : c.kind === 'folder')
				);
				if (!child) {
					child = { name: part, path: sofar, kind: isFile ? 'file' : 'folder', children: [] };
					node.children.push(child);
				}
				node = child;
			}
		}
		sort(root);
		return root;
	}
	// Folders first, then files; the Kit conventions (+layout, +page) float to the top of a folder.
	function rank(n: TreeNodeData): number {
		if (n.kind === 'folder') return 0;
		if (/^\+layout\b/.test(n.name)) return 1;
		if (/^\+page\b/.test(n.name)) return 2;
		return 3;
	}
	function sort(n: TreeNodeData) {
		n.children.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
		for (const c of n.children) if (c.kind === 'folder') sort(c);
	}

	const tree = $derived(build(files));

	function icon(name: string): string {
		if (/\.svelte$/.test(name)) return '◆';
		if (/\.(ts|js)$/.test(name)) return '⬡';
		if (/\.(json)$/.test(name)) return '{}';
		if (/\.(md|svx)$/.test(name)) return '¶';
		return '·';
	}
	const toggle = (path: string) => {
		if (collapsed.has(path)) collapsed.delete(path);
		else collapsed.add(path);
	};

	// Hand shared state + callbacks to every descendant TreeNode. Getters keep `active`/`entry`
	// reactive across the context boundary.
	set_tree_ctx({
		get active() {
			return active;
		},
		get protectedFile() {
			return entry;
		},
		collapsed,
		onselect: (p) => onselect(p),
		onremove: (p) => onremove(p),
		onmove: (from, toDir) => onmove?.(from, toDir),
		dir_of,
		icon,
		toggle,
		get winner() {
			return winner;
		},
		mark_over: (key) => (winner = key),
		unmark_over: (key) => {
			if (winner === key) winner = null;
		},
		end_drag: () => (winner = null)
	});
</script>

<div class="ftree" data-obs-filetree>
	<div class="ftree-head">
		<span class="ftree-title">files</span>
		<span class="ftree-actions">
			<button
				class="ftree-add"
				title="add a file (name may include folders, e.g. lib/Widget.svelte)"
				onclick={onadd}>+</button
			>
			{#if oncollapse}
				<button class="ftree-add ftree-collapse" title="collapse the file tree" onclick={oncollapse}
					>«</button
				>
			{/if}
		</span>
	</div>
	<!-- The body is the ROOT drop zone: dropping a nested file here moves it to the workspace root.
	     neodrag owns the drag listeners (attachment), so no static-element a11y handlers are added. -->
	<div class="ftree-body" class:drop-root={winner === ROOT_KEY} {...rootDrop.attach}>
		{#each tree.children as node (node.path)}
			<TreeNode {node} depth={0} />
		{/each}
	</div>
</div>

<style>
	.ftree {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--bg-raised, #101713);
		font-size: 12px;
	}
	.ftree-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 7px 10px 7px 12px;
		border-bottom: 1px solid rgba(148, 163, 184, 0.12);
	}
	.ftree-title {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-dim);
	}
	.ftree-actions {
		display: flex;
		gap: 4px;
	}
	.ftree-add {
		width: 20px;
		height: 20px;
		display: grid;
		place-items: center;
		border: 1px solid var(--line, #1c2620);
		border-radius: 5px;
		background: var(--bg, #0a0f0d);
		color: var(--text-dim);
		font-size: 14px;
		line-height: 1;
		cursor: pointer;
	}
	.ftree-collapse {
		font-size: 12px;
	}
	.ftree-add:hover {
		border-color: var(--accent);
		color: var(--accent);
	}
	.ftree-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 4px 0 10px;
	}
	.ftree-body.drop-root {
		outline: 1px dashed var(--accent);
		outline-offset: -3px;
		background: color-mix(in oklab, var(--accent) 5%, transparent);
	}
</style>
