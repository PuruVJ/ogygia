<script>
	/**
	 * The Wire tab (wire inspector, internal/notes/devtools.md, Rung 5 · 2): everything the SERVER
	 * shipped to this page across the island boundary — each island's devalue PROPS payload, the
	 * document seeds ($app/state page + remote query cache), and the signed capabilities minted for
	 * deferred holes. The data-crossing counterpart to the Bytes tab (which is code). Reads the
	 * server-realm events the handle folded into the stream via the `application/ogygia-devtools`
	 * side-channel; nothing here needs a socket — it's the same in-page bus.
	 */
	import { snapshot } from './bus.js';
	import { short_chunk, kb } from './regions.js';

	let { tick = 0 } = $props();

	const model = $derived.by(() => {
		tick; // refresh with the panel tick
		const ev = snapshot();
		const renders = ev.filter((e) => e.name === 'server.region.rendered');
		const seeds = ev.filter((e) => e.name === 'server.seed.injected');
		const caps = ev.filter((e) => e.name === 'server.capability.minted');
		const propsBytes = renders.reduce((s, r) => s + (r.propsBytes || 0), 0);
		const seedBytes = seeds.reduce((s, r) => s + (r.bytes || 0), 0);
		return { renders, seeds, caps, propsBytes, seedBytes, total: propsBytes + seedBytes };
	});
</script>

<h4>wire inspector — what the server shipped to this page</h4>

{#if model.renders.length === 0 && model.seeds.length === 0 && model.caps.length === 0}
	<div class="muted">no server crossings recorded — needs a devtools build (the handle's side-channel feeds this).</div>
{:else}
	<div class="sec">islands · props payload</div>
	<table>
		<thead><tr><th>region</th><th>mode</th><th>fp</th><th>props</th></tr></thead>
		<tbody>
			{#each model.renders as r (r.seq)}
				<tr>
					<td title={r.entry || ''}>{short_chunk(r.entry) || '—'}</td>
					<td>{r.mode}</td>
					<td>{r.fp || '—'}</td>
					<td>{r.propsBytes != null ? r.propsBytes + ' B' : '—'}</td>
				</tr>
			{:else}
				<tr><td colspan="4" class="muted">none</td></tr>
			{/each}
		</tbody>
	</table>

	<div class="sec">document seeds</div>
	<table>
		<thead><tr><th>seed</th><th>bytes</th></tr></thead>
		<tbody>
			{#each model.seeds as s (s.seq)}
				<tr><td>{s.kind}</td><td>{s.bytes} B</td></tr>
			{:else}
				<tr><td colspan="2" class="muted">none</td></tr>
			{/each}
		</tbody>
	</table>

	{#if model.caps.length}
		<div class="sec">capabilities minted (deferred holes)</div>
		<table>
			<thead><tr><th>id</th><th>ttl</th></tr></thead>
			<tbody>
				{#each model.caps as c (c.seq)}
					<tr><td title={c.id}>{short_chunk(c.id) || c.id}</td><td>{c.ttl ? c.ttl + ' s' : 'no-store'}</td></tr>
				{/each}
			</tbody>
		</table>
	{/if}

	<div class="total">
		<span>data across the wire</span>
		<span>{kb(model.total)} <span class="muted">({model.propsBytes} B props + {model.seedBytes} B seeds)</span></span>
	</div>
{/if}

<style>
	h4 {
		margin: 0 0 8px;
		font-size: 12px;
		color: #5eead4;
	}
	.muted {
		color: #64748b;
	}
	.sec {
		margin: 12px 0 4px;
		color: #94a3b8;
		font-weight: 600;
	}
	.sec:first-of-type {
		margin-top: 0;
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
	td:first-child {
		text-align: left;
	}
	thead th {
		color: #94a3b8;
		border-bottom: 1px solid rgba(148, 163, 184, 0.2);
	}
	.total {
		display: flex;
		justify-content: space-between;
		margin-top: 12px;
		padding-top: 6px;
		border-top: 1px solid rgba(148, 163, 184, 0.2);
		color: #5eead4;
		font-weight: 600;
	}
</style>
