<script>
	/**
	 * The Bytes tab (byte ledger): real over-the-wire JS per island entry chunk + the shared runtime
	 * chunk, from PerformanceResourceTiming. Cold islands show `cold` and fill in live as the panel
	 * ticks. Measures each island's OWN chunk (not transitive deps); dev sizes are flagged.
	 */
	import { all_regions, chunk_bytes, basename, kb } from './regions.js';

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
			.map((g) => ({ ...g, ...chunk_bytes(g.entry) }))
			.sort((a, b) => b.wire - a.wire);

		const runtimeSrc =
			document.querySelector('script[data-ogygia-runtime]')?.getAttribute('src') || '';
		const runtime = runtimeSrc ? { src: runtimeSrc, ...chunk_bytes(runtimeSrc) } : null;

		// Page total over UNIQUE chunks.
		const counted = new Set();
		let wire = 0;
		let raw = 0;
		for (const row of rows) {
			if (!row.loaded || counted.has(basename(row.entry))) continue;
			counted.add(basename(row.entry));
			wire += row.wire;
			raw += row.raw;
		}
		if (runtime?.loaded && !counted.has(basename(runtime.src))) {
			wire += runtime.wire;
			raw += runtime.raw;
		}
		return { rows, runtime, totalWire: wire, totalRaw: raw };
	});
</script>

<h4>byte ledger — JavaScript shipped</h4>
{#if IS_DEV}
	<div class="note">dev server — sizes are unbundled/unminified, not representative. Build + preview for real numbers.</div>
{/if}

<table>
	<thead>
		<tr><th>chunk</th><th>kind</th><th>over&nbsp;wire</th><th>raw</th></tr>
	</thead>
	<tbody>
		{#each model.rows as row (row.entry)}
			<tr>
				<td title={row.entry}>
					{basename(row.entry)}{#if row.count > 1}<span class="muted"> ×{row.count}</span>{/if}
				</td>
				<td>{row.kind}{row.kind === 'island' ? ' · ' + row.wake : ''}</td>
				<td>{#if row.loaded}{kb(row.wire)}{:else}<span class="muted">cold</span>{/if}</td>
				<td>{#if row.loaded}{kb(row.raw)}{:else}<span class="muted">—</span>{/if}</td>
			</tr>
		{:else}
			<tr><td colspan="4" class="muted">no island chunks on this page</td></tr>
		{/each}
		{#if model.runtime}
			<tr>
				<td>ogygia runtime</td>
				<td class="muted">shared</td>
				<td>{model.runtime.loaded ? kb(model.runtime.wire) : '—'}</td>
				<td>{model.runtime.loaded ? kb(model.runtime.raw) : '—'}</td>
			</tr>
		{/if}
	</tbody>
	<tfoot>
		<tr>
			<td>page total (unique chunks)</td><td></td>
			<td>{kb(model.totalWire)}</td><td>{kb(model.totalRaw)}</td>
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
</style>
