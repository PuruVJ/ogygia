<script lang="ts">
	// The Observatory's file tree (left pane). Builds a folder tree from the file map's keys — a key is a
	// path, so `src/lib/Counter.svelte` nests under src › lib, while a bare `App.svelte` sits at the root.
	// Backward-compatible: flat presets (no `/`) render as a flat list. Folders collapse; files select +
	// remove. Drag-to-reorder is layered on top separately.
	import { SvelteSet } from 'svelte/reactivity';
	type FileMap = Record<string, string>;
	type Node = { name: string; path: string; kind: 'file' | 'folder'; children: Node[] };

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

	// ── Drag-and-drop (move a file into a folder, VS Code-style). Drop targets are folders + the root. ──
	let dragPath = $state<string | null>(null);
	let dropDir = $state<string | null>(null); // the folder path being hovered ('' = root)
	const dir_of = (p: string): string => {
		const i = p.lastIndexOf('/');
		return i < 0 ? '' : p.slice(0, i);
	};
	function start_drag(e: DragEvent, path: string) {
		dragPath = path;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', path);
		}
	}
	function over_dir(e: DragEvent, dir: string) {
		if (!dragPath || dir_of(dragPath) === dir) return; // already there → not a drop target
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dropDir = dir;
	}
	function drop_on(e: DragEvent, dir: string) {
		e.preventDefault();
		const from = dragPath;
		dragPath = null;
		dropDir = null;
		if (from && dir_of(from) !== dir) onmove?.(from, dir);
	}
	function end_drag() {
		dragPath = null;
		dropDir = null;
	}

	// Which folders are collapsed (by full path). Default: everything expanded — a codebase you just
	// opened should show itself. Collapsing is opt-in and remembered while the workspace is loaded.
	let collapsed = $state(new SvelteSet<string>());

	// The row snippet renders RECURSIVELY (one call per folder level), so a pathological key with hundreds
	// of `/` segments would overflow the call stack. Cap the tree depth: overflow segments collapse into
	// the leaf's name. No real workspace nests this deep; a hostile/shared one can't crash the tree.
	const MAX_TREE_DEPTH = 12;
	function build(map: FileMap): Node {
		const root: Node = { name: '', path: '', kind: 'folder', children: [] };
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
				let child = node.children.find((c) => c.name === part && (isFile ? c.kind === 'file' : c.kind === 'folder'));
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
	function rank(n: Node): number {
		if (n.kind === 'folder') return 0;
		if (/^\+layout\b/.test(n.name)) return 1;
		if (/^\+page\b/.test(n.name)) return 2;
		return 3;
	}
	function sort(n: Node) {
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
	// The one file that can't be removed — the render entry (removing it would leave nothing to render).
	const protectedFile = $derived(entry);
</script>

<div class="ftree" data-obs-filetree>
	<div class="ftree-head">
		<span class="ftree-title">files</span>
		<span class="ftree-actions">
			<button class="ftree-add" title="add a file (name may include folders, e.g. lib/Widget.svelte)" onclick={onadd}>+</button>
			{#if oncollapse}
				<button class="ftree-add ftree-collapse" title="collapse the file tree" onclick={oncollapse}>«</button>
			{/if}
		</span>
	</div>
	<!-- The body is the ROOT drop target: dropping a nested file here moves it to the workspace root.
	     Drag-to-move is a mouse enhancement; the +/× buttons are the keyboard-accessible file ops. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="ftree-body"
		class:drop-root={dropDir === ''}
		ondragover={(e) => over_dir(e, '')}
		ondragleave={() => { if (dropDir === '') dropDir = null; }}
		ondrop={(e) => drop_on(e, '')}
	>
		{#each tree.children as node (node.path)}
			{@render row(node, 0)}
		{/each}
	</div>
</div>

{#snippet row(node: Node, depth: number)}
	{#if node.kind === 'folder'}
		<button
			class="frow folder"
			class:drop={dropDir === node.path}
			style:--depth={depth}
			onclick={() => toggle(node.path)}
			ondragover={(e) => over_dir(e, node.path)}
			ondragleave={() => { if (dropDir === node.path) dropDir = null; }}
			ondrop={(e) => drop_on(e, node.path)}
			title={node.path}
		>
			<span class="ftw">{collapsed.has(node.path) ? '▸' : '▾'}</span>
			<span class="fname">{node.name}</span>
		</button>
		{#if !collapsed.has(node.path)}
			{#each node.children as child (child.path)}
				{@render row(child, depth + 1)}
			{/each}
		{/if}
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="frow file"
			class:on={active === node.path}
			class:dragging={dragPath === node.path}
			style:--depth={depth}
			data-obs-file={node.path}
			draggable="true"
			ondragstart={(e) => start_drag(e, node.path)}
			ondragend={end_drag}
		>
			<button class="fopen" onclick={() => onselect(node.path)} title={node.path}>
				<span class="fic">{icon(node.name)}</span>
				<span class="fname">{node.name}</span>
			</button>
			{#if node.path !== protectedFile}
				<button
					class="frm"
					title="remove {node.name}"
					onclick={(e) => {
						e.stopPropagation();
						onremove(node.path);
					}}>×</button
				>
			{/if}
		</div>
	{/if}
{/snippet}

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
	.frow {
		display: flex;
		align-items: center;
		width: 100%;
		gap: 5px;
		padding: 2px 8px 2px calc(8px + var(--depth, 0) * 13px);
		border: 0;
		background: none;
		color: var(--text-dim);
		font: inherit;
		text-align: left;
		cursor: pointer;
		border-radius: 0;
	}
	.frow.folder {
		color: var(--text);
		font-weight: 600;
	}
	.frow.folder:hover,
	.frow.file:hover {
		background: rgba(148, 163, 184, 0.08);
	}
	.frow.file.on {
		background: color-mix(in oklab, var(--accent) 16%, transparent);
	}
	.frow.file.on .fname {
		color: var(--text);
		font-weight: 600;
	}
	/* ── drag-and-drop (move a file into a folder) ── */
	.frow.file {
		cursor: grab;
	}
	.frow.file.dragging {
		opacity: 0.45;
	}
	.frow.folder.drop {
		background: color-mix(in oklab, var(--accent) 22%, transparent);
		outline: 1px dashed var(--accent);
		outline-offset: -2px;
	}
	.ftree-body.drop-root {
		outline: 1px dashed var(--accent);
		outline-offset: -3px;
		background: color-mix(in oklab, var(--accent) 5%, transparent);
	}
	.frow.file {
		padding: 0;
	}
	.fopen {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 1;
		min-width: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		padding: 2px 4px 2px calc(8px + var(--depth, 0) * 13px);
	}
	.ftw {
		width: 10px;
		flex: none;
		font-size: 9px;
		color: var(--text-dim);
	}
	.fic {
		width: 12px;
		flex: none;
		text-align: center;
		font-size: 10px;
		color: color-mix(in oklab, var(--accent) 70%, var(--text-dim));
	}
	.fname {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.frm {
		flex: none;
		width: 20px;
		border: 0;
		background: none;
		color: var(--text-dim);
		font-size: 14px;
		line-height: 1;
		cursor: pointer;
		opacity: 0;
	}
	.frow.file:hover .frm {
		opacity: 0.7;
	}
	.frm:hover {
		opacity: 1 !important;
		color: #f87171;
	}
</style>
