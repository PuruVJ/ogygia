<script>
	/**
	 * The Hub tab (hub inspector, internal/notes/devtools.md, Rung 5 · 6): ogygia's identity spine made
	 * visible. Every transportable that crosses an island boundary — a wired class, a store, a snippet,
	 * a held region, a hoisted fn — is a hub Ref with one id, and the browser MEMOIZES decode by id so
	 * N islands holding the same handle REUNITE on ONE live instance. This tab shows that: per id, its
	 * kind, how many times it was resolved (= how many carriers picked it up), and how many of those
	 * were REUNIONS (a memo hit returning the existing instance vs a first fresh decode). Plus the
	 * dispose reaping that runs on navigation. Reads hub.mint / hub.resolve / hub.dispose off the bus.
	 */
	import { snapshot } from './bus.js';

	let { tick = 0 } = $props();

	function short_id(id) {
		return id && id.length > 12 ? id.slice(0, 8) + '…' : id;
	}

	const model = $derived.by(() => {
		tick; // refresh with the panel tick
		const ev = snapshot();
		const byId = new Map();
		const get = (id) => {
			let m = byId.get(id);
			if (!m) byId.set(id, (m = { id, kind: '', tag: '', scope: '', resolves: 0, reunions: 0 }));
			return m;
		};
		for (const e of ev) {
			if (e.name === 'hub.mint') {
				const m = get(e.id);
				m.kind = e.kind;
				if (e.tag) m.tag = e.tag;
			} else if (e.name === 'hub.resolve') {
				const m = get(e.id);
				if (!m.kind) m.kind = e.kind;
				m.scope = e.scope;
				m.resolves++;
				if (e.hit) m.reunions++;
			}
		}
		const rows = [...byId.values()].sort((a, b) => b.resolves - a.resolves);
		const disposes = ev.filter((e) => e.name === 'hub.dispose');
		return { rows, disposes };
	});
</script>

<h4>hub inspector — shared identity across islands</h4>

{#if model.rows.length === 0}
	<div class="muted">
		no hub activity on this page. Visit a page with a wired class / store / held region (e.g.
		<b>/transportable</b> or <b>/lab/wire</b>) — then reopen this tab.
	</div>
{:else}
	<table>
		<thead>
			<tr><th>id</th><th>kind</th><th>scope</th><th>resolves</th><th>reunions</th></tr>
		</thead>
		<tbody>
			{#each model.rows as r (r.id)}
				<tr>
					<td title={r.tag ? `${r.id} · ${r.tag}` : r.id}>{short_id(r.id)}</td>
					<td><span class="kind">{r.kind || '—'}</span></td>
					<td>{r.scope || '—'}</td>
					<td>{r.resolves}</td>
					<td class:shared={r.reunions > 0}>{r.reunions}{#if r.reunions > 0}<span class="badge">1 instance</span>{/if}</td>
				</tr>
			{/each}
		</tbody>
	</table>
	<div class="note muted">
		<b>reunions</b> = times an existing live instance was returned instead of decoding a fresh one —
		so a row with N resolves and N−1 reunions is ONE object shared by N islands.
	</div>

	{#if model.disposes.length}
		<div class="sec">dispose (nav teardown)</div>
		<table>
			<thead><tr><th>scope</th><th>instances</th></tr></thead>
			<tbody>
				{#each model.disposes as d (d.seq)}
					<tr><td>{d.scope}</td><td>{d.count}</td></tr>
				{/each}
			</tbody>
		</table>
	{/if}
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
	.muted b {
		color: #94a3b8;
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
	.kind {
		color: #c4b5fd;
	}
	.shared {
		color: #5eead4;
	}
	.badge {
		margin-left: 6px;
		padding: 0 6px;
		border-radius: 999px;
		font-size: 10px;
		background: rgba(20, 184, 166, 0.18);
		color: #5eead4;
	}
	.note {
		margin-top: 8px;
		line-height: 1.5;
	}
	.sec {
		margin: 12px 0 4px;
		color: #94a3b8;
		font-weight: 600;
	}
</style>
