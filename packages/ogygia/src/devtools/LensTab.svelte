<script>
	/**
	 * The Lens tab: toggles the page-tinting {@link ./BoundaryOverlay.svelte overlay} and lists every
	 * region with its kind / schedule / hydration state. The overlay itself is drawn by BoundaryOverlay
	 * (a sibling under the root app); this tab just controls it and mirrors the region roster.
	 */
	import { all_regions, short_chunk } from './regions.js';

	let { tick = 0, overlay = $bindable(false) } = $props();

	const regions = $derived.by(() => {
		tick; // refresh with the panel tick
		return all_regions();
	});
	const counts = $derived.by(() => {
		const c = { island: 0, lake: 0, hole: 0 };
		for (const r of regions) c[r.kind]++;
		return c;
	});
</script>

<h4>boundary lens</h4>

<div class="controls">
	<button class="btn" data-og-overlay-toggle class:on={overlay} onclick={() => (overlay = !overlay)}>
		{overlay ? 'hide overlay' : 'show overlay'}
	</button>
	<span class="legend">
		<span class="sw island"></span>island {counts.island}
		<span class="sw lake"></span>lake {counts.lake}
		<span class="sw hole"></span>hole {counts.hole}
	</span>
</div>

<table>
	<thead>
		<tr><th>region</th><th>kind</th><th>wake</th><th>state</th></tr>
	</thead>
	<tbody>
		{#each regions as r (r.el)}
			<tr>
				<td title={r.entry || r.fp || ''}>{short_chunk(r.entry) || (r.fp ? r.fp.slice(0, 10) : '—')}</td>
				<td><span class="dot {r.kind}"></span>{r.kind}</td>
				<td>{r.kind === 'island' ? r.wake : '—'}</td>
				<td class:cold={r.kind === 'island' && !r.hydrated}>
					{r.kind === 'island' ? (r.hydrated ? 'hydrated' : 'cold') : r.hydrated ? 'filled' : 'pending'}
				</td>
			</tr>
		{:else}
			<tr><td colspan="4" class="muted">no regions on this page</td></tr>
		{/each}
	</tbody>
</table>

<style>
	h4 {
		margin: 0 0 8px;
		font-size: 12px;
		color: #5eead4;
	}
	.controls {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 10px;
	}
	.btn {
		padding: 5px 11px;
		border-radius: 7px;
		border: 1px solid rgba(148, 163, 184, 0.3);
		background: #0d1526;
		color: #e2e8f0;
		cursor: pointer;
		font: inherit;
	}
	.btn.on {
		background: #14b8a6;
		color: #022;
		border-color: #0d9488;
	}
	.legend {
		color: #94a3b8;
		display: flex;
		align-items: center;
		gap: 6px;
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
		margin-right: 6px;
		vertical-align: 0;
	}
	table {
		border-collapse: collapse;
		width: 100%;
	}
	th,
	td {
		text-align: right;
		padding: 2px 8px;
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
	.muted {
		color: #64748b;
	}
	.cold {
		color: #94a3b8;
	}
</style>
