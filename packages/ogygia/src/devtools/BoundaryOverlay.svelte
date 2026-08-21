<script>
	/**
	 * The boundary-lens OVERLAY: tints every `<ogygia-region>` on the page by kind (island / lake /
	 * hole), dashed while cold, and shows a hover tooltip that fuses DOM state with bus data (props
	 * bytes from the server render, hydrate ms from the client wake — joined by fingerprint). The
	 * overlay is `pointer-events:none`, so the page stays fully interactive; hover is read off the real
	 * element under the cursor. A pure consumer; rendered only while `overlay` is on.
	 */
	import { all_regions, region_info, latest_event, short_chunk } from './regions.js';

	let { overlay = false } = $props();

	// A frame counter bumped by rAF while the overlay is on — box rects follow scroll / hydration.
	let frame = $state(0);
	$effect(() => {
		if (!overlay) return;
		let raf = 0;
		const loop = () => {
			frame++;
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	});

	const boxes = $derived.by(() => {
		frame; // reactive dependency: recompute each animation frame
		if (!overlay) return [];
		return all_regions()
			.map((r) => ({ info: r, rect: r.el.getBoundingClientRect() }))
			.filter((b) => b.rect.width > 0 || b.rect.height > 0);
	});

	// Hover tooltip state.
	let hover = $state(/** @type {null | { x: number; y: number; el: Element }} */ (null));
	function on_move(e) {
		if (!overlay) {
			hover = null;
			return;
		}
		const el = e.target instanceof Element ? e.target.closest('ogygia-region') : null;
		hover = el ? { x: e.clientX, y: e.clientY, el } : null;
	}

	const tip = $derived.by(() => {
		if (!hover) return null;
		const info = region_info(hover.el);
		const rendered = info.fp
			? latest_event((ev) => ev.name === 'server.region.rendered' && ev.fp === info.fp)
			: null;
		const hyd = info.fp
			? latest_event((ev) => ev.name === 'region.hydrate.done' && ev.fp === info.fp)
			: null;
		return {
			kind: info.kind,
			wake: info.wake,
			entry: info.entry,
			fp: info.fp,
			state:
				info.kind === 'island'
					? info.hydrated
						? 'hydrated'
						: 'cold'
					: info.hydrated
						? 'filled'
						: 'pending',
			props: rendered && typeof rendered.propsBytes === 'number' ? rendered.propsBytes : null,
			ms: hyd && typeof hyd.ms === 'number' ? hyd.ms : null,
			serverRendered: !!rendered
		};
	});
</script>

<svelte:window onmousemove={on_move} />

{#if overlay}
	<div class="og-overlay" data-og-overlay>
		{#each boxes as b (b.info.el)}
			<div
				class="box {b.info.kind}"
				data-og-box={b.info.kind}
				class:cold={b.info.kind === 'island' && !b.info.hydrated}
				style:left="{b.rect.left}px"
				style:top="{b.rect.top}px"
				style:width="{b.rect.width}px"
				style:height="{b.rect.height}px"
			>
				<span class="tag {b.info.kind}"
					>{b.info.kind}{b.info.kind === 'island' ? ' · ' + b.info.wake : ''}</span
				>
			</div>
		{/each}
	</div>

	{#if tip}
		<div
			class="tip"
			style:left="{Math.min(hover.x + 14, innerWidth - 320)}px"
			style:top="{Math.min(hover.y + 14, innerHeight - 140)}px"
		>
			<div class="head"><b class={tip.kind}>{tip.kind}</b> · {tip.wake}</div>
			{#if tip.entry}<div class="row"><span class="k">entry</span><span>{short_chunk(tip.entry)}</span></div>{/if}
			{#if tip.fp}<div class="row"><span class="k">fp</span><span>{tip.fp}</span></div>{/if}
			<div class="row"><span class="k">state</span><span>{tip.state}</span></div>
			{#if tip.props != null}<div class="row"><span class="k">props</span><span>{tip.props} B</span></div>{/if}
			{#if tip.ms != null}<div class="row"><span class="k">hydrate</span><span>{tip.ms.toFixed(1)} ms</span></div>{/if}
			<div class="row"><span class="k">server-rendered</span><span>{tip.serverRendered ? 'yes' : 'no'}</span></div>
		</div>
	{/if}
{/if}

<style>
	.og-overlay {
		position: fixed;
		inset: 0;
		pointer-events: none;
		z-index: 2147483000;
		font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.box {
		position: absolute;
		box-sizing: border-box;
		border-radius: 4px;
		border: 1.5px solid;
	}
	.box.island {
		border-color: #14b8a6;
		background: rgba(20, 184, 166, 0.14);
	}
	.box.lake {
		border-color: #f59e0b;
		background: rgba(245, 158, 11, 0.14);
	}
	.box.hole {
		border-color: #8b5cf6;
		background: rgba(139, 92, 246, 0.14);
	}
	.box.cold {
		border-style: dashed;
		opacity: 0.75;
	}
	.tag {
		position: absolute;
		top: -1px;
		left: -1px;
		padding: 1px 5px;
		border-radius: 4px 0 4px 0;
		color: #021;
		font-weight: 600;
		white-space: nowrap;
	}
	.tag.island {
		background: #14b8a6;
	}
	.tag.lake {
		background: #f59e0b;
	}
	.tag.hole {
		background: #8b5cf6;
	}
	.tip {
		position: fixed;
		z-index: 2147483600;
		pointer-events: none;
		max-width: 340px;
		padding: 8px 10px;
		border-radius: 8px;
		background: #0b1220;
		color: #e2e8f0;
		border: 1px solid rgba(148, 163, 184, 0.3);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
		font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
		white-space: nowrap;
	}
	.tip .head {
		margin-bottom: 2px;
	}
	.tip b.island {
		color: #5eead4;
	}
	.tip b.lake {
		color: #fbbf24;
	}
	.tip b.hole {
		color: #c4b5fd;
	}
	.tip .row {
		display: flex;
		gap: 10px;
		justify-content: space-between;
	}
	.tip .k {
		color: #94a3b8;
	}
</style>
