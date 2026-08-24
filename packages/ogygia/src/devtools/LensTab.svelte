<script>
	/**
	 * The Lens tab: toggles the page-tinting {@link ./BoundaryOverlay.svelte overlay} and lists every
	 * region by NAME with its kind / schedule / JS cost / hydration state. Hovering a row lights up the
	 * matching box on the page (shared `focus`), and clicking a row smooth-scrolls that region into
	 * view — so the roster is a live index into the page, not just a static table. The overlay itself is
	 * drawn by BoundaryOverlay (a sibling under the root app); this tab controls it and mirrors it.
	 */
	import { all_regions, region_name, region_transitive } from './regions.js';

	let {
		tick = 0,
		overlay = $bindable(false),
		focus = $bindable(null),
		selected = $bindable(null),
		picking = $bindable(false)
	} = $props();

	const kb = (n) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB');

	const regions = $derived.by(() => {
		tick; // refresh with the panel tick
		return all_regions().map((r) => ({
			r,
			name: region_name(r.entry),
			js: r.kind === 'island' ? region_transitive(r.entry) : null
		}));
	});
	const summary = $derived.by(() => {
		const c = { island: 0, lake: 0, hole: 0 };
		let js = 0;
		let cold = 0;
		for (const { r, js: t } of regions) {
			c[r.kind]++;
			if (t) js += t.bytes;
			if (r.kind === 'island' && !r.hydrated) cold++;
		}
		return { ...c, js, cold };
	});

	function state_of(r) {
		if (r.kind === 'island') return r.hydrated ? 'hydrated' : 'cold';
		return r.hydrated ? 'filled' : 'pending';
	}
	function toggle_pick() {
		picking = !picking;
		if (picking) overlay = true; // need the boxes visible to pick one on the page
	}
</script>

<div class="cap">
	boundary lens <span class="muted">· every region on the page, x-rayed</span>
</div>

<div class="controls">
	<button class="btn" data-og-overlay-toggle class:on={overlay} onclick={() => (overlay = !overlay)}>
		<span class="eye"></span>{overlay ? 'hide overlay' : 'show overlay'}
	</button>
	<button class="btn pick" data-og-pick class:on={picking} onclick={toggle_pick} title="then click an island on the page">
		<span class="target"></span>{picking ? 'click an island…' : 'pick on page'}
	</button>
	<span class="legend">
		<span class="sw island"></span>{summary.island}
		<span class="sw lake"></span>{summary.lake}
		<span class="sw hole"></span>{summary.hole}
	</span>
	{#if summary.js > 0}<span class="tot">{kb(summary.js)} JS{#if summary.cold}<span class="muted"> · {summary.cold} cold</span>{/if}</span>{/if}
</div>

<table>
	<thead>
		<tr><th>island</th><th>wake</th><th>js + deps</th><th>state</th></tr>
	</thead>
	<tbody>
		{#each regions as { r, name, js } (r.el)}
			<tr
				class:on={focus === r.el}
				class:cold={r.kind === 'island' && !r.hydrated}
				onmouseenter={() => (focus = r.el)}
				onmouseleave={() => (focus = null)}
				onclick={() => (selected = r.el)}
				title="inspect this region"
			>
				<td><span class="dot {r.kind}"></span><span class="nm">{name}</span></td>
				<td>{r.kind === 'island' ? r.wake : r.kind}</td>
				<td class="mono">
					{#if r.kind !== 'island'}<span class="muted">0 B</span>
					{:else if js}{kb(js.bytes)}
					{:else}<span class="muted">—</span>{/if}
				</td>
				<td class:coldstate={r.kind === 'island' && !r.hydrated}>{state_of(r)}</td>
			</tr>
		{:else}
			<tr><td colspan="4" class="muted">no regions on this page</td></tr>
		{/each}
	</tbody>
</table>

<style>
	.cap {
		font-size: 12px;
		color: #5eead4;
		margin-bottom: 8px;
	}
	.controls {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 10px;
	}
	.btn {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 5px 11px;
		border-radius: 7px;
		border: 1px solid rgba(148, 163, 184, 0.3);
		background: #0d1526;
		color: #e2e8f0;
		cursor: pointer;
		font: inherit;
	}
	.btn .eye {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		border: 1.5px solid currentColor;
		opacity: 0.7;
	}
	.btn.on {
		background: #14b8a6;
		color: #022;
		border-color: #0d9488;
	}
	.btn.on .eye {
		opacity: 1;
		background: currentColor;
	}
	.btn.pick .target {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: 1.5px solid currentColor;
		position: relative;
		opacity: 0.75;
	}
	.btn.pick .target::after {
		content: '';
		position: absolute;
		inset: 3px;
		border-radius: 50%;
		background: currentColor;
	}
	.btn.pick.on {
		background: #f59e0b;
		color: #201400;
		border-color: #d97706;
	}
	.btn.pick.on .target {
		opacity: 1;
	}
	.legend {
		color: #94a3b8;
		display: flex;
		align-items: center;
		gap: 5px;
	}
	.tot {
		margin-left: auto;
		color: #5eead4;
		font-weight: 600;
	}
	.sw {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 3px;
		margin-left: 6px;
	}
	.sw.island,
	.dot.island {
		background: #14b8a6;
	}
	.sw.lake,
	.dot.lake {
		background: #f59e0b;
	}
	.sw.hole,
	.dot.hole {
		background: #8b5cf6;
	}
	.dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		margin-right: 7px;
		vertical-align: 0;
	}
	.nm {
		color: #e2e8f0;
		font-weight: 600;
	}
	table {
		border-collapse: collapse;
		width: 100%;
	}
	th,
	td {
		text-align: right;
		padding: 3px 8px;
		white-space: nowrap;
	}
	th:first-child,
	td:first-child,
	th:nth-child(2),
	td:nth-child(2) {
		text-align: left;
	}
	thead th {
		color: #94a3b8;
		border-bottom: 1px solid rgba(148, 163, 184, 0.2);
	}
	tbody tr {
		cursor: pointer;
		border-radius: 5px;
	}
	tbody tr:hover,
	tbody tr.on {
		background: rgba(94, 234, 212, 0.12);
	}
	tbody tr.on {
		box-shadow: inset 2px 0 0 #5eead4;
	}
	.muted {
		color: #64748b;
	}
	.mono {
		font-variant-numeric: tabular-nums;
	}
	.coldstate {
		color: #94a3b8;
	}
</style>
