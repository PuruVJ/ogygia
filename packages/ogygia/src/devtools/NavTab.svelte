<script>
	/**
	 * The Nav tab (nav lab, internal/notes/devtools.md, Rung 5 · 4): makes an SPA navigation
	 * observable. ogygia navs DIFF the body in place — matched regions keep their live island, changed
	 * ones re-mount, the shell morphs. This tab shows the LAST navigation's per-region decision by
	 * COMPONENT NAME (keep / patch / mount / remove) + its timing (reconciled vs full-swap, View
	 * Transition, how many deferred holes were single-flighted), and a short history. Reads
	 * nav.start/finish/reconcile/batch off the bus. The decision-based counterpart to the Timeline.
	 */
	import { snapshot } from './bus.js';
	import { region_name, region_name_by_fp } from './regions.js';

	let { tick = 0 } = $props();

	const DECISION = {
		keep: { c: '#22c55e', help: 'same island reused — its live state survived the nav' },
		patch: { c: '#f59e0b', help: 'same slot, inputs changed — re-mounted in place' },
		mount: { c: '#38bdf8', help: 'new island — appeared on this page' },
		remove: { c: '#ef4444', help: 'island gone — left with the old page' }
	};
	const ORDER = ['keep', 'patch', 'mount', 'remove'];

	// The reconcile key is `<type>\0<value>`: k = keep-marker name, p = persist signature, r = props fp.
	function label_of(d) {
		if (d.entry) return region_name(d.entry);
		const nul = (d.key || '').indexOf('\0');
		const type = nul >= 0 ? d.key.slice(0, nul) : '';
		const val = nul >= 0 ? d.key.slice(nul + 1) : d.key || '';
		if (type === 'k') return val || '(kept)';
		if (type === 'r') return region_name_by_fp(val);
		if (type === 'p') return 'persisted region';
		return val || '—';
	}
	function origin_of(d) {
		const t = (d.key || '').slice(0, (d.key || '').indexOf('\0'));
		return t === 'k' ? 'keep' : t === 'p' ? 'persist' : '';
	}

	const model = $derived.by(() => {
		tick; // refresh with the panel tick
		const ev = snapshot();
		const finishes = ev.filter((e) => e.name === 'nav.finish');
		if (finishes.length === 0) return { hasNav: false };

		const last = finishes[finishes.length - 1];
		const start = ev.filter((e) => e.name === 'nav.start' && e.seq < last.seq).at(-1);
		const from = start?.seq ?? -1;
		const decisions = ev
			.filter((e) => e.name === 'nav.reconcile' && e.seq > from && e.seq < last.seq)
			.slice()
			.sort((a, b) => ORDER.indexOf(a.decision) - ORDER.indexOf(b.decision));
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

<div class="cap">nav lab <span class="muted">· the last SPA navigation's per-island decisions</span></div>

{#if !model.hasNav}
	<div class="muted">no navigation yet — click a link (SPA nav) and reopen this tab.</div>
{:else}
	<div class="summary">
		<span class="path">{model.from ?? '?'} → <b>{model.last.to}</b></span>
		<span class="pill" class:good={model.last.reconciled}
			>{model.last.reconciled ? 'reconciled in place' : 'full swap'}</span
		>
		<span class="pill">{model.last.ms.toFixed(1)} ms</span>
		<span class="pill">VT {model.last.vt ? 'on' : 'off'}</span>
		{#if model.batch}<span class="pill">single-flight ×{model.batch.count}</span>{/if}
	</div>

	<div class="counts">
		{#each ORDER as name}
			<span class="chip" class:zero={!model.counts[name]} style:--c={DECISION[name].c} title={DECISION[name].help}>
				{name} {model.counts[name]}
			</span>
		{/each}
	</div>

	{#if model.decisions.length}
		<table>
			<thead><tr><th>island</th><th>wake</th><th>fate</th></tr></thead>
			<tbody>
				{#each model.decisions as d (d.seq)}
					<tr>
						<td title={d.key}>
							<span class="nm">{label_of(d)}</span>
							{#if origin_of(d)}<span class="via">via {origin_of(d)}</span>{/if}
						</td>
						<td>{d.wake || '—'}</td>
						<td title={DECISION[d.decision].help}>
							<span class="dot" style:background={DECISION[d.decision].c}></span>{d.decision}
						</td>
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
				<tr><td class="nm">{h.to}</td><td>{h.ms.toFixed(1)}</td><td>{h.reconciled ? 'reconciled' : 'full swap'}</td></tr>
			{/each}
		</tbody>
	</table>
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
	.summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-bottom: 10px;
	}
	.path {
		color: #94a3b8;
	}
	.path b {
		color: #e2e8f0;
	}
	.pill {
		padding: 2px 8px;
		border-radius: 999px;
		border: 1px solid rgba(148, 163, 184, 0.3);
		color: #94a3b8;
	}
	.pill.good {
		border-color: rgba(34, 197, 94, 0.4);
		color: #4ade80;
	}
	.counts {
		display: flex;
		gap: 8px;
		margin-bottom: 12px;
	}
	.chip {
		padding: 2px 9px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--c) 18%, transparent);
		color: var(--c);
		font-weight: 600;
		cursor: default;
	}
	.chip.zero {
		background: none;
		color: #475569;
	}
	.dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		margin-right: 6px;
		vertical-align: 0;
	}
	.nm {
		color: #e2e8f0;
		font-weight: 600;
	}
	.via {
		margin-left: 7px;
		color: #64748b;
		font-size: 10px;
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
	.sec {
		margin: 14px 0 4px;
		color: #94a3b8;
		font-weight: 600;
	}
</style>
