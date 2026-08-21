<script>
	/**
	 * The Nav tab (nav lab, internal/notes/devtools.md, Rung 5 · 4): makes an SPA navigation
	 * observable. ogygia navs DIFF the body in place — matched regions keep their live island, changed
	 * ones re-mount, the shell morphs. This tab shows the LAST navigation's per-region decision
	 * (keep / patch / mount / remove) + its timing (reconciled vs full-swap, View Transition, how many
	 * deferred holes were single-flighted), and a short history. Reads nav.start/finish/reconcile/batch
	 * off the bus. The decision-based counterpart to the (time-based) Timeline.
	 */
	import { snapshot } from './bus.js';

	let { tick = 0 } = $props();

	const DECISION = {
		keep: '#22c55e',
		patch: '#f59e0b',
		mount: '#38bdf8',
		remove: '#ef4444'
	};

	function short_key(k) {
		// reconcile keys look like `r <fp>` / `k <name>` / `p <sig>`
		const parts = (k || '').split(' ');
		const head = parts[0];
		const rest = parts.slice(1).join(' ');
		return `${head} ${rest.length > 14 ? rest.slice(0, 12) + '…' : rest}`.trim();
	}

	const model = $derived.by(() => {
		tick; // refresh with the panel tick
		const ev = snapshot();
		const finishes = ev.filter((e) => e.name === 'nav.finish');
		if (finishes.length === 0) return { hasNav: false };

		const last = finishes[finishes.length - 1];
		const start = ev.filter((e) => e.name === 'nav.start' && e.seq < last.seq).at(-1);
		const from = start?.seq ?? -1;
		const decisions = ev.filter(
			(e) => e.name === 'nav.reconcile' && e.seq > from && e.seq < last.seq
		);
		const batch = ev
			.filter((e) => e.name === 'nav.batch' && e.seq > from && e.seq <= last.seq)
			.at(-1);
		const counts = { keep: 0, patch: 0, mount: 0, remove: 0 };
		for (const d of decisions) counts[d.decision]++;
		const history = finishes
			.slice(-8)
			.reverse()
			.map((f) => ({ to: f.to, ms: f.ms, reconciled: f.reconciled, vt: f.vt, seq: f.seq }));
		return { hasNav: true, last, from: start?.from, decisions, counts, batch, history };
	});
</script>

<h4>nav lab — per-region reconcile decisions</h4>

{#if !model.hasNav}
	<div class="muted">no navigation yet — click a link (SPA nav) and reopen this tab.</div>
{:else}
	<div class="summary">
		<span class="path">{model.from ?? '?'} → <b>{model.last.to}</b></span>
		<span class="pill">{model.last.reconciled ? 'reconciled (in-place)' : 'full swap'}</span>
		<span class="pill">{model.last.ms.toFixed(1)} ms</span>
		<span class="pill">VT {model.last.vt ? 'on' : 'off'}</span>
		{#if model.batch}<span class="pill">single-flight {model.batch.count}</span>{/if}
	</div>

	<div class="counts">
		{#each Object.entries(model.counts) as [name, n]}
			<span class="chip" style:--c={DECISION[name]}>{name} {n}</span>
		{/each}
	</div>

	{#if model.decisions.length}
		<table>
			<thead><tr><th>region key</th><th>decision</th></tr></thead>
			<tbody>
				{#each model.decisions as d (d.seq)}
					<tr>
						<td title={d.key}>{short_key(d.key)}</td>
						<td><span class="dot" style:background={DECISION[d.decision]}></span>{d.decision}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<div class="muted">this nav was a full swap (no per-region diff) — decisions only exist on the reconcile path.</div>
	{/if}

	<div class="sec">recent navigations</div>
	<table>
		<thead><tr><th>to</th><th>ms</th><th>path</th></tr></thead>
		<tbody>
			{#each model.history as h (h.seq)}
				<tr><td>{h.to}</td><td>{h.ms.toFixed(1)}</td><td>{h.reconciled ? 'reconciled' : 'full swap'}</td></tr>
			{/each}
		</tbody>
	</table>
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
	.summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-bottom: 10px;
	}
	.path {
		color: #e2e8f0;
	}
	.path b {
		color: #5eead4;
	}
	.pill {
		padding: 2px 8px;
		border-radius: 999px;
		border: 1px solid rgba(148, 163, 184, 0.3);
		color: #94a3b8;
	}
	.counts {
		display: flex;
		gap: 8px;
		margin-bottom: 10px;
	}
	.chip {
		padding: 2px 9px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--c) 18%, transparent);
		color: var(--c);
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
	.sec {
		margin: 12px 0 4px;
		color: #94a3b8;
		font-weight: 600;
	}
</style>
