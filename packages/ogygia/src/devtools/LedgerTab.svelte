<script>
	/**
	 * The Bytes tab (byte ledger): real over-the-wire JS per island entry chunk + the shared runtime
	 * chunk, from PerformanceResourceTiming. Cold islands show `cold` and fill in live as the panel
	 * ticks. Measures each island's OWN chunk (not transitive deps); dev sizes are flagged.
	 */
	import {
		all_regions,
		chunk_bytes,
		basename,
		kb,
		region_name,
		region_transitive
	} from './regions.js';

	let { tick = 0 } = $props();
	const IS_DEV = !!(import.meta.env && import.meta.env.DEV);

	const model = $derived.by(() => {
		tick; // refresh with the panel tick

		// Group regions by entry chunk (dedupe: same component + strategy = ONE chunk, N instances).
		const groups = new Map();
		for (const r of all_regions()) {
			if (!r.entry) continue;
			const key = basename(r.entry);
			const g = groups.get(key);
			if (g) g.count++;
			else groups.set(key, { entry: r.entry, kind: r.kind, wake: r.wake, count: 1 });
		}

		const rows = [...groups.values()]
			.map((g) => {
				const t = region_transitive(g.entry);
				return {
					...g,
					...chunk_bytes(g.entry),
					name: region_name(g.entry),
					transitive: t ? t.bytes : 0,
					modules: t ? t.modules : 0
				};
			})
			// Sort by the real (transitive) cost when we have it, else by the entry-chunk wire size.
			.sort((a, b) => b.transitive - a.transitive || b.wire - a.wire);

		const runtimeSrc =
			document.querySelector('script[data-ogygia-runtime]')?.getAttribute('src') || '';
		const runtime = runtimeSrc ? { src: runtimeSrc, ...chunk_bytes(runtimeSrc) } : null;

		// Page total over UNIQUE chunks (rows are already one-per-island). `wire` = wrapper chunks;
		// `transitive` = each island's whole subgraph (the real-cost column).
		const counted = new Set();
		let wire = 0;
		let transitive = 0;
		for (const row of rows) {
			const key = basename(row.entry);
			if (counted.has(key)) continue;
			counted.add(key);
			if (row.loaded) wire += row.wire;
			transitive += row.transitive;
		}
		if (runtime?.loaded && !counted.has(basename(runtime.src))) wire += runtime.wire;
		return { rows, runtime, totalWire: wire, totalTransitive: transitive };
	});
</script>

<h4>byte ledger — JavaScript per island</h4>
{#if IS_DEV}
	<div class="note">
		dev estimate — <b>+deps</b> sums the island's whole module subgraph (component + everything it
		imports), so it reflects real cost, not just the wrapper. Sizes are unbundled/unminified; build
		+ preview for shipped numbers. A cold island (not yet woken) shows <b>—</b> until it loads.
	</div>
{/if}

<table>
	<thead>
		<tr><th>island</th><th>kind</th><th>wrapper</th><th>+deps</th></tr>
	</thead>
	<tbody>
		{#each model.rows as row (row.entry)}
			<tr>
				<td title={row.entry}>
					<span class="nm">{row.name}</span>{#if row.count > 1}<span class="muted"> ×{row.count}</span>{/if}
				</td>
				<td>{row.kind}{row.kind === 'island' ? ' · ' + row.wake : ''}</td>
				<td>{#if row.loaded}{kb(row.wire)}{:else}<span class="muted">cold</span>{/if}</td>
				<td>
					{#if row.transitive}
						<span class="strong">{kb(row.transitive)}</span><span class="muted"> · {row.modules} mod</span>
					{:else}<span class="muted">—</span>{/if}
				</td>
			</tr>
		{:else}
			<tr><td colspan="4" class="muted">no island chunks on this page</td></tr>
		{/each}
		{#if model.runtime}
			<tr>
				<td>ogygia runtime</td>
				<td class="muted">shared</td>
				<td>{model.runtime.loaded ? kb(model.runtime.wire) : '—'}</td>
				<td class="muted">—</td>
			</tr>
		{/if}
	</tbody>
	<tfoot>
		<tr>
			<td>page total</td><td class="muted">unique · +deps</td>
			<td>{kb(model.totalWire)}</td><td>{kb(model.totalTransitive)}</td>
		</tr>
	</tfoot>
</table>

<style>
	h4 {
		margin: 0 0 8px;
		font-size: 12px;
		color: #5eead4;
	}
	.note {
		color: #64748b;
		margin-bottom: 6px;
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
	tfoot td {
		border-top: 1px solid rgba(148, 163, 184, 0.2);
		color: #5eead4;
		font-weight: 600;
	}
	.muted {
		color: #64748b;
	}
	.nm {
		color: #e2e8f0;
		font-weight: 600;
	}
	.strong {
		color: #e2e8f0;
	}
</style>
