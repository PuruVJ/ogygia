<script>
	/**
	 * The boundary-lens OVERLAY: draws a labelled box over every `<ogygia-region>` on the page — tinted
	 * by kind (island / lake / hole), dashed while cold — and, on hover, a rich card that fuses DOM
	 * state with bus data (props bytes from the server render, hydrate ms from the client wake, joined
	 * by fingerprint) and the compiler's per-island JS cost. Each box is labelled by COMPONENT NAME, and
	 * islands show their JS-with-deps inline, so the page x-rays into the ogygia thesis at a glance.
	 *
	 * `focus` is a two-way bridge to the Lens tab: the region under the cursor here lights up the
	 * matching roster row there, and vice-versa; whichever region is focused stands out while the rest
	 * dim. The overlay is `pointer-events:none`, so the page stays fully interactive — hover is read off
	 * the real element under the cursor via `<svelte:window>`. A pure consumer, drawn only while on.
	 */
	import { onMount } from 'svelte';
	import {
		all_regions,
		region_info,
		latest_event,
		region_name,
		region_transitive
	} from './regions.js';

	let {
		overlay = false,
		focus = $bindable(null),
		selected = null,
		picking = $bindable(false),
		onpick
	} = $props();

	const kb = (n) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB');

	function pick(el) {
		onpick?.(el);
		picking = false;
	}
	// A frame counter that advances only while the overlay is on — box rects follow scroll / hydration.
	let frame = $state(0);
	// One-time wiring (lifecycle, not an effect): Esc cancels a half-started pick, and a single rAF loop
	// bumps `frame` while the overlay is on. Both read their reactive props live at call time.
	onMount(() => {
		const onkey = (e) => {
			if (e.key === 'Escape' && picking) picking = false;
		};
		window.addEventListener('keydown', onkey);
		let raf = requestAnimationFrame(function loop() {
			if (overlay) frame++;
			raf = requestAnimationFrame(loop);
		});
		return () => {
			window.removeEventListener('keydown', onkey);
			cancelAnimationFrame(raf);
		};
	});

	const boxes = $derived.by(() => {
		frame; // reactive dependency: recompute each animation frame
		if (!overlay) return [];
		return all_regions()
			.map((r) => {
				const t = r.kind === 'island' ? region_transitive(r.entry) : null;
				return { info: r, name: region_name(r.entry), js: t ? t.bytes : null, rect: r.el.getBoundingClientRect() };
			})
			.filter((b) => b.rect.width > 0 || b.rect.height > 0);
	});

	// Hover tooltip state (local — drives the card). `focus` is the shared cross-highlight key.
	let hover = $state(/** @type {null | { x: number; y: number; el: Element }} */ (null));
	function on_move(e) {
		if (!overlay) {
			hover = null;
			return;
		}
		// The devtools lives in a shadow root, so `e.target` retargets to the host — read the composed
		// path's innermost element to tell "over the page" from "over the dock".
		const t = e.composedPath?.()[0] ?? e.target;
		// Pointer over the dock UI → drop the page tip so it can't hover-cover the panel, but leave
		// `focus` to the Lens tab (its roster rows drive it).
		if (t instanceof Element && t.closest('[data-og-win],[data-og-panel-toggle]')) {
			hover = null;
			return;
		}
		let el = t instanceof Element ? t.closest('ogygia-region') : null;
		// In pick mode the box catches the pointer (not the region under it) — resolve back by fp.
		if (!el && t instanceof Element) {
			const fp = t.closest('[data-og-box]')?.getAttribute('data-og-fp');
			if (fp) el = document.querySelector(`ogygia-region[data-og-fp="${CSS.escape(fp)}"]`);
		}
		hover = el ? { x: e.clientX, y: e.clientY, el } : null;
		focus = el;
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
		const t = info.kind === 'island' ? region_transitive(info.entry) : null;
		return {
			name: region_name(info.entry),
			kind: info.kind,
			wake: info.wake,
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
			js: t ? t.bytes : null,
			mods: t ? t.modules : null,
			serverRendered: !!rendered
		};
	});
</script>

<svelte:window onmousemove={on_move} />

{#if overlay}
	<div class="og-overlay" data-og-overlay class:focusing={focus != null || selected != null}>
		{#each boxes as b (b.info.el)}
			<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
			<div
				class="box og-{b.info.kind}"
				data-og-box={b.info.kind}
				data-og-fp={b.info.fp}
				class:cold={b.info.kind === 'island' && !b.info.hydrated}
				class:on={focus === b.info.el || selected === b.info.el}
				class:selected={selected === b.info.el}
				class:pickable={picking}
				onclick={picking ? () => pick(b.info.el) : null}
				role={picking ? 'button' : null}
				tabindex={picking ? -1 : null}
				style:left="{b.rect.left}px"
				style:top="{b.rect.top}px"
				style:width="{b.rect.width}px"
				style:height="{b.rect.height}px"
			>
				<span class="tag og-{b.info.kind}">
					<b>{b.name}</b><span class="meta"
						>{b.info.kind === 'island' ? ' ' + b.info.wake : ' ' + b.info.kind}{b.js != null
							? ' · ' + kb(b.js)
							: ''}</span
					>
				</span>
			</div>
		{/each}
	</div>

	{#if picking}
		<div class="pickhint">click an island to inspect · <b>Esc</b> to cancel</div>
	{/if}

	{#if tip}
		<div
			class="tip"
			style:left="{Math.min(hover.x + 14, innerWidth - 300)}px"
			style:top="{Math.min(hover.y + 14, innerHeight - 160)}px"
		>
			<div class="head">
				<span class="dot og-{tip.kind}"></span><b>{tip.name}</b>
			</div>
			<div class="sub og-{tip.kind}">
				{tip.kind}{tip.kind === 'island' ? ` · wakes on ${tip.wake}` : ''} · {tip.state}
			</div>
			<div class="rows">
				{#if tip.js != null}
					<div class="row">
						<span class="k">js + deps</span><span>{kb(tip.js)}<span class="mut"> · {tip.mods} mod</span></span>
					</div>
				{/if}
				{#if tip.props != null}
					<div class="row"><span class="k">props</span><span>{tip.props} B</span></div>
				{/if}
				{#if tip.ms != null}
					<div class="row"><span class="k">hydrated in</span><span>{tip.ms.toFixed(1)} ms</span></div>
				{/if}
				<div class="row">
					<span class="k">server-rendered</span><span>{tip.serverRendered ? 'yes' : 'no'}</span>
				</div>
				{#if tip.fp}<div class="row"><span class="k">fp</span><span class="mono">{tip.fp}</span></div>{/if}
			</div>
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
		transition: opacity 0.12s ease;
	}
	.box.og-island {
		border-color: #14b8a6;
		background: rgba(20, 184, 166, 0.12);
	}
	.box.og-lake {
		border-color: #f59e0b;
		background: rgba(245, 158, 11, 0.12);
	}
	.box.og-hole {
		border-color: #8b5cf6;
		background: rgba(139, 92, 246, 0.12);
	}
	.box.cold {
		border-style: dashed;
	}
	/* When ANY region is focused, dim the rest so the focused one reads clearly. */
	.og-overlay.focusing .box:not(.on) {
		opacity: 0.3;
	}
	.box.on {
		z-index: 1;
		box-shadow:
			0 0 0 2px rgba(94, 234, 212, 0.5),
			0 6px 20px rgba(0, 0, 0, 0.35);
	}
	.box.selected {
		box-shadow:
			0 0 0 2px #5eead4,
			0 8px 24px rgba(0, 0, 0, 0.4);
	}
	/* Pick mode: boxes catch the pointer (the rest of the overlay stays click-through). */
	.box.pickable {
		pointer-events: auto;
		cursor: crosshair;
	}
	.pickhint {
		position: fixed;
		top: 12px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 2147483600;
		pointer-events: none;
		padding: 6px 14px;
		border-radius: 999px;
		background: #f59e0b;
		color: #201400;
		font-weight: 600;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
	}
	.pickhint b {
		font-weight: 700;
	}
	.box.on.og-island {
		background: rgba(20, 184, 166, 0.22);
	}
	.box.on.og-lake {
		background: rgba(245, 158, 11, 0.22);
	}
	.box.on.og-hole {
		background: rgba(139, 92, 246, 0.22);
	}
	.tag {
		position: absolute;
		top: -1px;
		left: -1px;
		max-width: 100vw;
		padding: 2px 6px;
		border-radius: 4px 0 4px 0;
		color: #021;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tag b {
		font-weight: 700;
	}
	.tag .meta {
		font-weight: 500;
		opacity: 0.8;
	}
	.tag.og-island {
		background: #14b8a6;
	}
	.tag.og-lake {
		background: #f59e0b;
	}
	.tag.og-hole {
		background: #8b5cf6;
	}
	.tip {
		position: fixed;
		z-index: 2147483600;
		pointer-events: none;
		min-width: 190px;
		max-width: 320px;
		padding: 9px 11px;
		border-radius: 9px;
		background: #0b1220;
		color: #e2e8f0;
		border: 1px solid rgba(148, 163, 184, 0.3);
		box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
		font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.tip .head {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
	}
	.tip .head b {
		color: #e2e8f0;
		font-weight: 700;
	}
	.tip .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: none;
	}
	.tip .dot.og-island {
		background: #14b8a6;
	}
	.tip .dot.og-lake {
		background: #f59e0b;
	}
	.tip .dot.og-hole {
		background: #8b5cf6;
	}
	.tip .sub {
		margin: 1px 0 7px 14px;
		color: #94a3b8;
	}
	.tip .sub.og-island {
		color: #5eead4;
	}
	.tip .sub.og-lake {
		color: #fbbf24;
	}
	.tip .sub.og-hole {
		color: #c4b5fd;
	}
	.tip .rows {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.tip .row {
		display: flex;
		gap: 12px;
		justify-content: space-between;
	}
	.tip .k {
		color: #94a3b8;
	}
	.tip .mut {
		color: #64748b;
	}
	.tip .mono {
		color: #cbd5e1;
	}
</style>
