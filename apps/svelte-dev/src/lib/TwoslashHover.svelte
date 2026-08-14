<script lang="ts">
	/**
	 * Twoslash hover tooltips — the client half of typed code fences. An ISLAND (`wake: load`, mounted
	 * once in the docs layout): the server bakes the type info into each `.twoslash-hover` span's
	 * hidden `.twoslash-popup-container`; this reads that markup on hover and floats it at the cursor.
	 *
	 * CSS-only would suffice for showing the popup, but a floating panel must be re-anchored so it
	 * never clips the viewport — that positioning is the only reason this needs JS. Delegated listeners
	 * on `document`, so it covers every fence on the page and survives SPA body-swaps.
	 */
	import { on } from 'svelte/events';
	import { onMount } from 'svelte';

	let panel = $state<HTMLDivElement | null>(null);
	let html = $state('');
	let x = $state(0);
	let y = $state(0);
	let open = $state(false);
	let hide_timer: ReturnType<typeof setTimeout> | undefined;

	function show(target: HTMLElement) {
		const container = target.querySelector('.twoslash-popup-container');
		if (!container) return;
		clearTimeout(hide_timer);
		html = container.innerHTML;
		const r = target.getBoundingClientRect();
		x = r.left + window.scrollX;
		y = r.bottom + window.scrollY + 6;
		open = true;
	}

	function schedule_hide() {
		clearTimeout(hide_timer);
		hide_timer = setTimeout(() => (open = false), 120);
	}

	onMount(() => {
		const over = on(document, 'mouseover', (e) => {
			const hit = (e.target as Element)?.closest?.('.twoslash-hover') as HTMLElement | null;
			if (hit) show(hit);
		});
		const out = on(document, 'mouseout', (e) => {
			if ((e.target as Element)?.closest?.('.twoslash-hover')) schedule_hide();
		});
		return () => {
			over();
			out();
			clearTimeout(hide_timer);
		};
	});

	// Once mounted + measured, nudge left so the panel never spills past the right edge.
	$effect(() => {
		if (!open || !panel) return;
		const w = panel.offsetWidth;
		const max = window.scrollX + document.documentElement.clientWidth - 16;
		if (x + w > max) x = Math.max(window.scrollX + 8, max - w);
	});
</script>

<div
	bind:this={panel}
	class="twoslash-tooltip"
	class:visible={open}
	style="left:{x}px; top:{y}px"
	role="tooltip"
	onmouseenter={() => clearTimeout(hide_timer)}
	onmouseleave={schedule_hide}
>
	{@html html}
</div>

<style>
	.twoslash-tooltip {
		position: absolute;
		z-index: 50;
		display: none;
		max-width: min(52rem, calc(100vw - 2rem));
		max-height: 30rem;
		overflow-y: auto;
		padding: 1.2rem 1.4rem;
		background: var(--sk-bg-2);
		border: 1px solid var(--sk-border);
		border-radius: var(--sk-border-radius);
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.16);
		font: var(--sk-font-mono);
		font-size: 1.3rem;
		line-height: 1.5;
		text-align: left;
		white-space: normal;
	}
	.twoslash-tooltip.visible {
		display: block;
	}
</style>
