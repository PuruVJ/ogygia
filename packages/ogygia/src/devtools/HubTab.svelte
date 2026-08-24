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

	// A transportable's registration tag is `<module path>#<ExportName>` — the class/const name is the
	// part after `#`. That's the human label; the id is a mint hash (fall back to it when untagged).
	function short_id(id) {
		return id && id.length > 12 ? id.slice(0, 8) + '…' : id;
	}
	function name_of(m) {
		if (m.tag) return m.tag.split('#').pop() || m.tag;
		return short_id(m.id);
	}

	// Kind → colour, so wire / store / snippet / region / fn read at a glance.
	const KIND = {
		wire: '#14b8a6',
		store: '#8b5cf6',
		snippet: '#f59e0b',
		region: '#38bdf8',
		fn: '#ec4899'
	};

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
				if (e.tag && !m.tag) m.tag = e.tag; // wire tag rides the client decode (mint is server-only)
				m.scope = e.scope;
				m.resolves++;
				if (e.hit) m.reunions++;
			}
		}
		// Shared instances (reunited at least once) first — they ARE the story — then by carrier count.
		const rows = [...byId.values()].sort(
			(a, b) => b.reunions - a.reunions || b.resolves - a.resolves
		);
		const shared = rows.filter((r) => r.reunions > 0).length;
		const disposes = ev.filter((e) => e.name === 'hub.dispose');
		return { rows, shared, disposes };
	});
</script>

<div class="cap">
	hub inspector <span class="muted">· one live object, shared across islands by identity</span>
</div>

{#if model.rows.length === 0}
	<div class="muted">
		no hub activity on this page. Visit a page with a wired class / store / held region (e.g.
		<b>/transportable</b> or <b>/lab/wire</b>) — then reopen this tab.
	</div>
{:else}
	{#if model.shared > 0}
		<div class="hero">
			<b>{model.shared}</b> shared live object{model.shared === 1 ? '' : 's'} — each held by several
			islands but decoded ONCE, so every holder reunites on the same instance.
		</div>
	{/if}
	<table>
		<thead>
			<tr><th>object</th><th>kind</th><th>scope</th><th>held&nbsp;by</th><th>reunited</th></tr>
		</thead>
		<tbody>
			{#each model.rows as r (r.id)}
				<tr class:shared={r.reunions > 0}>
					<td title={r.tag || r.id}><span class="nm">{name_of(r)}</span></td>
					<td>
						<span class="dot" style:background={KIND[r.kind] || '#64748b'}></span>{r.kind || '—'}
					</td>
					<td class="muted">{r.scope || '—'}</td>
					<td>{r.resolves}×</td>
					<td>
						{#if r.reunions > 0}
							<span class="badge">1 instance · {r.reunions} reunion{r.reunions === 1 ? '' : 's'}</span>
						{:else}<span class="muted">fresh</span>{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
	<div class="note muted">
		<b>held by</b> = how many carriers (islands) picked this handle up. <b>reunited</b> = a memo hit
		returning the existing live instance instead of decoding a fresh one — the reunification that
		makes N islands share ONE reactive object.
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
	.cap {
		font-size: 12px;
		color: #5eead4;
		margin-bottom: 8px;
	}
	.muted {
		color: #64748b;
	}
	.muted b {
		color: #94a3b8;
	}
	.hero {
		margin-bottom: 10px;
		padding: 7px 10px;
		border-radius: 8px;
		background: rgba(20, 184, 166, 0.1);
		border: 1px solid rgba(20, 184, 166, 0.25);
		color: #cbd5e1;
		line-height: 1.5;
	}
	.hero b {
		color: #5eead4;
		font-size: 13px;
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
	.nm {
		color: #e2e8f0;
		font-weight: 600;
	}
	.dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		margin-right: 6px;
		vertical-align: 0;
	}
	tr.shared td {
		background: rgba(20, 184, 166, 0.08);
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
