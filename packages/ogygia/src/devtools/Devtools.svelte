<script>
	/**
	 * The devtools ROOT app — one component we `mount()` once (from ui.ts, behind the gate). It owns
	 * the launcher button, a draggable tabbed window, and the boundary overlay; each tab is a child
	 * component that reads the event bus. All UI state lives here as runes; children get `tick` (a
	 * refresh pulse while the window is open) + `overlay` (bindable, from the Lens tab).
	 */
	import LensTab from './LensTab.svelte';
	import LedgerTab from './LedgerTab.svelte';
	import TimelineTab from './TimelineTab.svelte';
	import WireTab from './WireTab.svelte';
	import HubTab from './HubTab.svelte';
	import NavTab from './NavTab.svelte';
	import BoundaryOverlay from './BoundaryOverlay.svelte';
	import { to_trace } from './sinks.js';

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

	const TABS = [
		{ id: 'lens', label: 'Lens' },
		{ id: 'bytes', label: 'Bytes' },
		{ id: 'wire', label: 'Wire' },
		{ id: 'hub', label: 'Hub' },
		{ id: 'nav', label: 'Nav' },
		{ id: 'timeline', label: 'Timeline' }
	];

	let open = $state(false);
	let tab = $state('lens');
	let overlay = $state(false);
	let tick = $state(0);

	// Refresh pulse while the window is open, so the active tab re-reads the bus/DOM live.
	$effect(() => {
		if (!open) return;
		const id = setInterval(() => tick++, 700);
		return () => clearInterval(id);
	});

	// Alt+O toggles the window.
	$effect(() => {
		const onkey = (e) => {
			if (e.altKey && (e.key === 'o' || e.key === 'O')) {
				e.preventDefault();
				open = !open;
			}
		};
		window.addEventListener('keydown', onkey);
		return () => window.removeEventListener('keydown', onkey);
	});

	// Drag the window by its header.
	let winEl = $state(/** @type {HTMLElement | null} */ (null));
	let pos = $state(/** @type {null | { left: number; top: number }} */ (null));
	let drag = null;
	function down(e) {
		if (e.target instanceof HTMLElement && e.target.closest('.tab, .x')) return;
		const r = winEl.getBoundingClientRect();
		drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
		e.currentTarget.setPointerCapture(e.pointerId);
	}
	function move(e) {
		if (!drag || !winEl) return;
		const w = winEl.offsetWidth;
		const h = winEl.offsetHeight;
		pos = {
			left: Math.max(4, Math.min(innerWidth - w - 4, e.clientX - drag.dx)),
			top: Math.max(4, Math.min(innerHeight - h - 4, e.clientY - drag.dy))
		};
	}
	function up(e) {
		drag = null;
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {
			/* already released */
		}
	}
</script>

<BoundaryOverlay {overlay} />

{#if open}
	<div
		class="win"
		data-og-win
		bind:this={winEl}
		style:left={pos ? pos.left + 'px' : null}
		style:top={pos ? pos.top + 'px' : null}
		style:right={pos ? 'auto' : null}
		style:bottom={pos ? 'auto' : null}
	>
		<div class="hd" role="toolbar" tabindex="-1" aria-label="ogygia devtools" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}>
			<span class="ttl">ogygia</span>
			{#each TABS as t}
				<button class="tab" data-og-tab={t.id} class:on={tab === t.id} onclick={() => (tab = t.id)}>
					{t.label}
				</button>
			{/each}
			<button class="trace" title="copy an event trace to the clipboard" onclick={copy_trace}>
				{copied ? 'copied ✓' : 'trace'}
			</button>
			<button class="x" title="close" onclick={() => (open = false)}>✕</button>
		</div>
		<div class="body">
			{#if tab === 'lens'}
				<LensTab {tick} bind:overlay />
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
			{/if}
		</div>
	</div>
{/if}

<button
	class="launch"
	data-og-panel-toggle
	class:on={open}
	title="ogygia devtools (Alt+O)"
	onclick={() => (open = !open)}
>
	<span class="dot"></span>og devtools
</button>

<style>
	.launch {
		position: fixed;
		right: 16px;
		bottom: 16px;
		z-index: 2147483600;
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 8px 13px;
		border-radius: 999px;
		border: 1px solid rgba(148, 163, 184, 0.35);
		background: #0b1220;
		color: #e2e8f0;
		font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
		cursor: pointer;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
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
	.win {
		position: fixed;
		right: 16px;
		bottom: 64px;
		z-index: 2147483550;
		width: min(680px, 94vw);
		height: min(460px, 72vh);
		display: flex;
		flex-direction: column;
		background: #0b1220;
		color: #e2e8f0;
		border: 1px solid rgba(148, 163, 184, 0.3);
		border-radius: 12px;
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
		overflow: hidden;
		font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.hd {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 8px 10px;
		cursor: grab;
		user-select: none;
		border-bottom: 1px solid rgba(148, 163, 184, 0.18);
		background: #0d1526;
	}
	.hd:active {
		cursor: grabbing;
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
</style>
