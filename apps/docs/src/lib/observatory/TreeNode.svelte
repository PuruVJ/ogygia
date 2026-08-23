<script lang="ts">
	// One row of the Observatory file tree, rendered RECURSIVELY (a folder renders its children as
	// more <TreeNode>s). Drag-and-drop is neodrag, not native HTML5 DnD — so it works on touch, shows
	// a floating ghost of the file, and (crucially) drops into the folder the pointer is actually over
	// instead of always landing at the root.
	//
	//  • files are DRAGGABLE  — `ghost` floats a dimmed clone under the cursor; the real row stays put.
	//  • files AND folders are DROP ZONES — a folder targets itself; a file targets its parent folder
	//    (so dropping onto a sibling file lands in that file's folder, VS Code-style). Nested zones are
	//    ranked by `priority` (file 2 > folder 1 > root 0) so the innermost one under the pointer wins.
	import { Draggable, ghost } from '@neodrag/svelte';
	import { Droppable, type DropAcceptCtx, type DropEventData } from '@neodrag/svelte/drop';
	import { get_tree_ctx, type TreeNodeData } from './tree-context';
	import Self from './TreeNode.svelte';

	let { node, depth }: { node: TreeNodeData; depth: number } = $props();
	const ctx = get_tree_ctx();

	// This row's stable drop-highlight key (`kind:path` can't collide with the root sentinel).
	const my_key = (): string => `${node.kind}:${node.path}`;
	// Where a drop on THIS row sends the file. A folder → into itself; a file → into its own folder.
	const target_dir = (): string => (node.kind === 'folder' ? node.path : ctx.dir_of(node.path));

	// A move is valid only when a file path is being dragged, it isn't this same file, and it isn't
	// already in the target folder (a no-op move shouldn't highlight or fire). A file row wins over its
	// enclosing folder header (priority 2 > 1) so hovering a file targets that file's folder precisely.
	const drop = new Droppable({
		collision: 'pointer',
		hitExpand: 4,
		get priority() {
			return node.kind === 'folder' ? 1 : 2;
		},
		get accepts() {
			return (c: DropAcceptCtx): boolean =>
				typeof c.data === 'string' && c.data !== node.path && ctx.dir_of(c.data) !== target_dir();
		},
		onEnter: () => {
			// Drilling in: hovering a collapsed folder during a drag opens it so you can aim deeper.
			if (node.kind === 'folder' && ctx.collapsed.has(node.path)) ctx.collapsed.delete(node.path);
		},
		// `onOver` fires only on the top-ranked zone under the pointer → exactly one row highlights.
		onOver: () => ctx.mark_over(my_key()),
		onLeave: () => ctx.unmark_over(my_key()),
		onDrop: (e: DropEventData) => {
			ctx.unmark_over(my_key());
			if (typeof e.data === 'string') ctx.onmove(e.data, target_dir());
		}
	});

	// Only files drag. Folders build the instance too (cheap) but keep it `disabled`, so no top-level
	// `node` read is needed to branch. The ghost clone follows the pointer; the original row just dims.
	const drag = new Draggable({
		threshold: 4,
		use: [ghost({ opacity: 0.75 })],
		get disabled() {
			return node.kind !== 'file';
		},
		get dragData() {
			return node.path;
		},
		onDragEnd: () => ctx.end_drag() // clear any lingering highlight if released off every zone
	});
</script>

{#if node.kind === 'folder'}
	<button
		class="frow folder"
		class:drop={ctx.winner === `folder:${node.path}`}
		style:--depth={depth}
		{...drop.attach}
		onclick={() => ctx.toggle(node.path)}
		title={node.path}
	>
		<span class="ftw">{ctx.collapsed.has(node.path) ? '▸' : '▾'}</span>
		<span class="fname">{node.name}</span>
	</button>
	{#if !ctx.collapsed.has(node.path)}
		{#each node.children as child (child.path)}
			<Self node={child} depth={depth + 1} />
		{/each}
	{/if}
{:else}
	<div
		class="frow file"
		class:on={ctx.active === node.path}
		class:dragging={drag.isDragging}
		class:drop={ctx.winner === `file:${node.path}`}
		style:--depth={depth}
		data-obs-file={node.path}
		{...drag.attach}
		{...drop.attach}
	>
		<button class="fopen" onclick={() => ctx.onselect(node.path)} title={node.path}>
			<span class="fic">{ctx.icon(node.name)}</span>
			<span class="fname">{node.name}</span>
		</button>
		{#if node.path !== ctx.protectedFile}
			<button
				class="frm"
				title="remove {node.name}"
				onclick={(e) => {
					e.stopPropagation();
					ctx.onremove(node.path);
				}}>×</button
			>
		{/if}
	</div>
{/if}

<style>
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
	/* ── drag-and-drop (neodrag) ── */
	.frow.file {
		cursor: grab;
		padding: 0;
	}
	.frow.file.dragging {
		opacity: 0.4;
	}
	/* A folder is a fill target: "the file lands INSIDE this folder." */
	.frow.folder.drop {
		background: color-mix(in oklab, var(--accent) 22%, transparent);
		outline: 1px dashed var(--accent);
		outline-offset: -2px;
	}
	/* A file is an insertion target: an accent line marks where the dragged file will join. */
	.frow.file.drop {
		box-shadow: inset 0 2px 0 0 var(--accent);
		background: color-mix(in oklab, var(--accent) 8%, transparent);
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
