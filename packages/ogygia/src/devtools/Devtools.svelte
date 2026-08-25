<script>
	/**
	 * The devtools ROOT app — one component we `mount()` once (from ui.ts, behind the gate). It owns the
	 * launcher, a draggable + resizable tabbed window, and the boundary overlay; each tab is a child that
	 * reads the event bus. All UI state lives here as runes; children get `tick` (a refresh pulse while
	 * the window is open) + `overlay` (bindable, from the Lens tab).
	 *
	 * Reactivity rule for this whole component: **no `$effect`.** Everything runs at the moment a value
	 * changes or a callback fires — neodrag's get/set option pairs persist layout on drag/resize end, the
	 * open/close path owns the refresh timer, and the one global keydown is registered in `onMount`.
	 *
	 * Drag/resize is @neodrag/svelte (a runtime dependency of ogygia, so the bare import resolves for any
	 * consumer). The window drags only by its header and may sit partly off-screen; everything lives inside
	 * a fixed, clipped, click-through root so an off-screen panel can never make the host page scroll.
	 */
	import LensTab from './LensTab.svelte';
	import LedgerTab from './LedgerTab.svelte';
	import TimelineTab from './TimelineTab.svelte';
	import WireTab from './WireTab.svelte';
	import HubTab from './HubTab.svelte';
	import NavTab from './NavTab.svelte';
	import ProfilerTab from './ProfilerTab.svelte';
	import { onMount } from 'svelte';
	import BoundaryOverlay from './BoundaryOverlay.svelte';
	import IslandDetail from './IslandDetail.svelte';
	import { to_trace } from './sinks.js';
	import { Draggable } from '@neodrag/svelte';
	import { Resizable, RESIZE_EDGES } from '@neodrag/svelte/resize';

	// `csrTrue` = mounted by the standalone boot on a Kit-hydrated (csr=true) page. The ogygia runtime
	// never ran there, so there's no event bus and no islands to inspect — the window shows a notice
	// pointing at a csr=false page instead of the (empty) instrument tabs.
	let { csrTrue = false } = $props();

	const TABS = [
		{ id: 'lens', label: 'Lens' },
		{ id: 'bytes', label: 'Bytes' },
		{ id: 'wire', label: 'Wire' },
		{ id: 'hub', label: 'Hub' },
		{ id: 'nav', label: 'Nav' },
		{ id: 'timeline', label: 'Timeline' },
		{ id: 'profiler', label: 'Profiler' }
	];

	// ── persisted layout (localStorage; written from callbacks, never an effect) ─────────────────────
	const LS_KEY = 'ogygia:devtools:layout:v4';
	function load_layout() {
		try {
			return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
		} catch {
			return {};
		}
	}
	const saved = load_layout();
	// The window is CSS-anchored top-left; neodrag's translate (`winPos`) places it. On the very first
	// open with nothing saved we drop it bottom-right, above the launcher (`place_near_launcher`).
	let launchPos = $state(saved.launch ?? { x: 0, y: 0 });
	// Two SEPARATE offsets: `winPos` is the drag translate, `winResizeOff` is the translate a w/n resize
	// induces to pin the far edge. neodrag SUMS both into the node transform, so they must be distinct —
	// binding one state to both doubled it and threw the window off-screen.
	let winPos = $state(saved.win ?? { x: 0, y: 0 });
	let winResizeOff = $state(saved.rz ?? { x: 0, y: 0 });
	let winSize = $state(saved.size ?? { width: 600, height: 680 });
	let open = $state(saved.open ?? false);
	let placed = saved.win != null;
	function save_layout() {
		try {
			localStorage.setItem(
				LS_KEY,
				JSON.stringify({ open, launch: launchPos, win: winPos, rz: winResizeOff, size: winSize })
			);
		} catch {
			/* private mode / quota — layout just won't persist */
		}
	}

	// ── neodrag: launcher drags whole; window drags by header, resizes by its edges ─────────────────
	const launchDrag = new Draggable({
		// Keep a grabbable sliver on-screen but otherwise let it roam.
		bounds: { target: 'viewport', padding: -80 },
		get position() {
			return launchPos;
		},
		set position(p) {
			launchPos = p;
		},
		onDragEnd: (e) => {
			launchPos = e.offset;
			save_layout();
		}
	});
	// Drag + resize COMPOSE through neodrag's shared transform: both bind the same `winPos` offset, so a
	// `w`/`n` resize's far-edge-pin translate and the drag translate never fight. The resize core also owns
	// applying width/height — we never set them ourselves. Negative bounds padding lets it roam anywhere,
	// partly off-screen (the clip root stops any page scroll); a sliver always stays grabbable.
	const winDrag = new Draggable({
		bounds: { target: 'viewport', padding: -240 },
		get position() {
			return winPos;
		},
		set position(p) {
			winPos = p;
		},
		onDragEnd: () => save_layout()
	});
	const winResize = new Resizable({
		minWidth: 300,
		minHeight: 200,
		get size() {
			return winSize;
		},
		set size(s) {
			winSize = s;
		},
		get position() {
			return winResizeOff;
		},
		set position(p) {
			winResizeOff = p;
		},
		onResizeEnd: () => save_layout()
	});
	// Stable attachment/handle objects — computed once so re-renders don't re-run the attachments.
	const winHandle = winDrag.handle();
	const winCancel = winDrag.cancel();
	// All eight edges — the shared-`winPos` composition above makes w/n resizes behave.
	const resizeHandles = RESIZE_EDGES.map((edge) => ({ edge, props: winResize.handle(edge) }));

	// ── open/close owns the live-refresh timer (no effect) ──────────────────────────────────────────
	let tab = $state('lens');
	let tick = $state(0);
	// Explicit hover state for the launcher (pointerenter/leave — a `:hover` descendant selector proved
	// flaky against neodrag's inline transform). `up` = fully revealed; otherwise it peeks below the fold.
	let launchHover = $state(false);
	let tickTimer = /** @type {ReturnType<typeof setInterval> | null} */ (null);
	function refresh_on() {
		if (!tickTimer) tickTimer = setInterval(() => tick++, 700);
	}
	function refresh_off() {
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
	}
	function place_near_launcher() {
		winPos = {
			x: Math.max(8, innerWidth - winSize.width - 24),
			y: Math.max(8, innerHeight - winSize.height - 88)
		};
	}
	function set_open(v) {
		open = v;
		if (open) {
			if (!placed) {
				place_near_launcher();
				placed = true;
			}
			refresh_on();
		} else {
			refresh_off();
		}
		save_layout();
	}
	function toggle_open() {
		set_open(!open);
	}

	// ── selection / picking (cross-highlight with the overlay + Lens tab) ───────────────────────────
	let overlay = $state(false);
	let focus = $state(/** @type {Element | null} */ (null));
	let selected = $state(/** @type {Element | null} */ (null));
	let picking = $state(false);
	// Picking an island on the page ends pick mode AND turns off the overlay the picker switched on — you
	// wanted THAT island, not the boxes. Done here at the assignment, not via an effect.
	function select_region(el) {
		selected = el;
		picking = false;
		overlay = false;
	}

	let copied = $state(false);
	async function copy_trace() {
		try {
			await navigator.clipboard.writeText(JSON.stringify(to_trace()));
			copied = true;
			setTimeout(() => (copied = false), 1200);
		} catch {
			/* clipboard blocked — no-op */
		}
	}

	// One-time setup: Alt+O toggle, the compiler's devtools metadata, and (re)starting the refresh timer
	// if we restored an open window. Returns the teardown — this is lifecycle, not reactive state.
	onMount(() => {
		const onkey = (e) => {
			if (e.altKey && (e.key === 'o' || e.key === 'O')) {
				e.preventDefault();
				toggle_open();
			}
		};
		window.addEventListener('keydown', onkey);

		// `names` (island id → component name) and `bytes` (island id → transitive dev-graph size) label
		// the tabs with real names/costs. Best-effort — the endpoint only exists on a dev devtools build.
		fetch('/__ogygia_devtools_meta')
			.then((r) => (r.ok ? r.json() : null))
			.then((meta) => {
				if (!meta || typeof meta !== 'object') return;
				if (meta.names) window.__ogygia_region_names = meta.names;
				if (meta.bytes) window.__ogygia_region_bytes = meta.bytes;
				tick++;
			})
			.catch(() => {});

		if (open) refresh_on();
		return () => {
			window.removeEventListener('keydown', onkey);
			refresh_off();
		};
	});
</script>

<BoundaryOverlay {overlay} bind:focus {selected} bind:picking onpick={select_region} />

<!-- Fixed, clipped, click-through root: absolute children (window/launcher) can be dragged partly
     off-screen and are clipped at the viewport edge, so the host page never gains a scrollbar. -->
<div class="og-root">
	{#if open}
		<section
			class="win"
			class:busy={winResize.isResizing || winDrag.isDragging}
			data-og-win
			{...winDrag.attach}
			{...winResize.attach}
		>
			<header class="hd" {...winHandle} role="toolbar" tabindex="-1" aria-label="ogygia devtools">
				<!-- Title bar = the drag zone. Only the two buttons on it are cancel zones, so most of the row
				     (grip + title + spacer) is a generous grab area with a grab cursor. -->
				<div class="bar">
					<span class="grip" aria-hidden="true"></span>
					<span class="ttl">ogygia devtools</span>
					{#if !csrTrue}
						<button class="trace" {...winCancel} title="copy an event trace to the clipboard" onclick={copy_trace}>
							{copied ? 'copied ✓' : 'trace'}
						</button>
					{:else}
						<span class="mode">csr=true</span>
					{/if}
					<button class="x" {...winCancel} title="close" onclick={() => set_open(false)}>✕</button>
				</div>
				{#if !csrTrue}
					<div class="tabs">
						{#each TABS as t}
							<button class="tab" {...winCancel} data-og-tab={t.id} class:on={tab === t.id} onclick={() => (tab = t.id)}>
								{t.label}
							</button>
						{/each}
					</div>
				{/if}
			</header>

			<div class="body">
				{#if csrTrue}
					<div class="notice" data-og-csr-notice>
						<p class="h">This page runs on <code>csr=true</code>.</p>
						<p>
							SvelteKit hydrates the whole page here, so ogygia's runtime never boots — there are no
							islands, no wire, and no byte ledger to inspect.
						</p>
						<p>Open a <code>csr=false</code> page to see the instruments.</p>
					</div>
				{:else if selected}
					<IslandDetail el={selected} {tick} onclose={() => (selected = null)} />
				{:else if tab === 'lens'}
					<LensTab {tick} bind:overlay bind:focus bind:selected bind:picking />
				{:else if tab === 'bytes'}
					<LedgerTab {tick} />
				{:else if tab === 'wire'}
					<WireTab {tick} />
				{:else if tab === 'hub'}
					<HubTab {tick} />
				{:else if tab === 'nav'}
					<NavTab {tick} />
				{:else if tab === 'timeline'}
					<TimelineTab {tick} />
				{:else if tab === 'profiler'}
					<ProfilerTab {tick} />
				{/if}
			</div>

			{#each resizeHandles as h (h.edge)}
				<div class="rh rh-{h.edge}" {...h.props}></div>
			{/each}
		</section>
	{/if}

	<div
		class="launch-wrap"
		{...launchDrag.attach}
		onpointerenter={() => (launchHover = true)}
		onpointerleave={() => (launchHover = false)}
	>
		<button
			class="launch"
			data-og-panel-toggle
			class:on={open}
			class:up={open || launchHover}
			title="ogygia devtools (Alt+O)"
			onclick={toggle_open}
		>
			<span class="dot"></span>og devtools
		</button>
	</div>
</div>

<style>
	.og-root {
		position: fixed;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
		z-index: 2147483550;
		font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
	}

	/* ── window ───────────────────────────────────────────────────────────── */
	.win {
		position: absolute;
		left: 0;
		top: 0;
		/* Pre-attach fallback size; neodrag's resize core applies the live/persisted size on mount. */
		width: 600px;
		height: 680px;
		pointer-events: auto;
		display: flex;
		flex-direction: column;
		background: #0b1220;
		color: #e2e8f0;
		border: 1px solid rgba(148, 163, 184, 0.3);
		border-radius: 12px;
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
		overflow: hidden;
	}
	/* While dragging or resizing, kill text selection so a gesture never highlights the panel's contents. */
	.win.busy,
	.win.busy * {
		user-select: none;
		-webkit-user-select: none;
	}
	.hd {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 8px 10px;
		cursor: grab;
		user-select: none;
		border-bottom: 1px solid rgba(148, 163, 184, 0.18);
		background: #0d1526;
	}
	.hd:active {
		cursor: grabbing;
	}
	/* Title bar — the drag zone. */
	.bar {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.grip {
		width: 16px;
		height: 12px;
		flex: none;
		background-image: radial-gradient(circle, #475569 1.1px, transparent 1.3px);
		background-size: 5px 5px;
		background-position: 1px 1px;
		opacity: 0.75;
	}
	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.ttl {
		font-weight: 700;
		color: #5eead4;
		margin-right: 8px;
		letter-spacing: 0.02em;
	}
	.tab {
		padding: 4px 10px;
		border-radius: 7px;
		border: 1px solid transparent;
		color: #94a3b8;
		cursor: pointer;
		background: none;
		font: inherit;
	}
	.tab.on {
		color: #e2e8f0;
		background: rgba(148, 163, 184, 0.14);
		border-color: rgba(148, 163, 184, 0.25);
	}
	.trace {
		margin-left: auto;
		padding: 3px 9px;
		border-radius: 7px;
		border: 1px solid rgba(148, 163, 184, 0.25);
		background: #0d1526;
		color: #94a3b8;
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}
	.trace:hover {
		color: #e2e8f0;
	}
	.x {
		color: #94a3b8;
		cursor: pointer;
		background: none;
		border: none;
		font: inherit;
		font-size: 14px;
		padding: 0 4px;
	}
	.body {
		flex: 1;
		overflow: auto;
		padding: 12px 14px;
	}
	/* csr=true header pill — takes the `margin-left:auto` slot the trace button usually holds. */
	.mode {
		margin-left: auto;
		padding: 3px 9px;
		border-radius: 7px;
		border: 1px solid rgba(251, 191, 36, 0.35);
		background: rgba(251, 191, 36, 0.1);
		color: #fbbf24;
		font-size: 11px;
		letter-spacing: 0.02em;
	}
	.notice {
		display: flex;
		flex-direction: column;
		gap: 10px;
		max-width: 46ch;
		color: #cbd5e1;
		line-height: 1.6;
	}
	.notice .h {
		color: #e2e8f0;
		font-weight: 600;
	}
	.notice code {
		padding: 1px 5px;
		border-radius: 5px;
		background: rgba(148, 163, 184, 0.16);
		color: #5eead4;
	}

	/* ── resize handles (neodrag marks them by data-attr; we place + size them) ── */
	.rh {
		position: absolute;
		z-index: 3;
	}
	.rh-n {
		top: -3px;
		left: 10px;
		right: 10px;
		height: 7px;
		cursor: ns-resize;
	}
	.rh-s {
		bottom: -3px;
		left: 10px;
		right: 10px;
		height: 7px;
		cursor: ns-resize;
	}
	.rh-e {
		right: -3px;
		top: 10px;
		bottom: 10px;
		width: 7px;
		cursor: ew-resize;
	}
	.rh-w {
		left: -3px;
		top: 10px;
		bottom: 10px;
		width: 7px;
		cursor: ew-resize;
	}
	.rh-ne {
		top: -4px;
		right: -4px;
		width: 14px;
		height: 14px;
		cursor: nesw-resize;
	}
	.rh-nw {
		top: -4px;
		left: -4px;
		width: 14px;
		height: 14px;
		cursor: nwse-resize;
	}
	.rh-se {
		bottom: -4px;
		right: -4px;
		width: 14px;
		height: 14px;
		cursor: nwse-resize;
	}
	.rh-sw {
		bottom: -4px;
		left: -4px;
		width: 14px;
		height: 14px;
		cursor: nesw-resize;
	}

	/* ── launcher: anchored to the bottom, peeks up half-hidden + faded, hover reveals ── */
	.launch-wrap {
		position: absolute;
		right: 24px;
		bottom: 0;
		pointer-events: auto;
	}
	.launch {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 9px 14px;
		border-radius: 999px;
		border: 1px solid rgba(148, 163, 184, 0.35);
		background: #0b1220;
		color: #e2e8f0;
		font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
		cursor: pointer;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
		/* Peeks up below the fold + dimmed until revealed (open or hovered). */
		transform: translateY(44%);
		opacity: 0.55;
		transition: transform 0.18s ease, opacity 0.18s ease, background 0.15s ease;
	}
	.launch.up {
		transform: translateY(-8px);
		opacity: 1;
	}
	.launch.on {
		background: #14b8a6;
		color: #022;
		border-color: #0d9488;
	}
	.launch .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: currentColor;
		opacity: 0.85;
	}
</style>
