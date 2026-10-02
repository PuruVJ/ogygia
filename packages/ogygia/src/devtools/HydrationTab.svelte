<script>
	/**
	 * The Hydration tab: did every island wake from its server markup, and if not, what differed.
	 * Per island: failed (threw), recovered (Svelte threw the server DOM away and rendered again),
	 * healed (another script edited it before it woke; the runtime put the server markup back),
	 * changed (the browser's first render differs from the server's), clean, or still asleep — with
	 * the runtime's own reason, and for a changed one the diff of server markup against the browser's
	 * (html-diff.ts). Hover a row: the island lights up. Sources: the bus (failed / recovered /
	 * healed events), the beacon's before/after markup, the element's `data-og-recovered` reason.
	 */
	import { hydration_rows, STATUS_RANK as RANK } from './hydration.js';
	import { html_diff } from './html-diff.js';
	import { highlight, clear_highlight } from './highlight.js';
	import { onMount } from 'svelte';

	let { tick = 0, selected = $bindable(null) } = $props();
	// a row with a difference to show opens it; any other row opens the island's card (a click that
	// did nothing on 8 of 9 rows is what the press-everything sweep found)
	function press(/** @type {{ el: Element; snap?: unknown; status: string }} */ r) {
		if (r.snap && r.status !== 'clean') open_el = open_el === r.el ? null : r.el;
		else selected = r.el;
	}
	// (by element: two copies of one island with the same props share a fingerprint)
	let open_el = $state(/** @type {Element | null} */ (null));

	const LABEL = { failed: 'failed', recovered: 'recovered', healed: 'healed', changed: 'markup changed', asleep: 'asleep', clean: 'clean' };

	const model = $derived.by(() => {
		tick;
		const { rows, measured } = hydration_rows();
		const counts = {};
		for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
		return { rows, counts, measured };
	});

	const diff = $derived.by(() => {
		const r = model.rows.find((x) => x.el === open_el);
		return r?.snap ? html_diff(r.snap.ssr, r.snap.hydrated) : null;
	});

	onMount(() => () => clear_highlight());
</script>

<div class="hy" data-og-hydration>
	<div class="cap">hydration <span class="muted">· did each island wake from its server markup</span></div>
	<div class="counts">
		{#each Object.keys(RANK) as s (s)}
			{#if model.counts[s]}<span class="badge {s}">{LABEL[s]} {model.counts[s]}</span>{/if}
		{/each}
	</div>
	{#if !model.measured}
		<p class="muted">The browser's before/after markup needs a measured page load (in a build: open devtools, then reload).</p>
	{/if}

	<table>
		<tbody>
			{#each model.rows as r (r.el)}
				<tr
					class="row {r.status}"
					data-status={r.status}
					onmouseenter={() => highlight([r.el], `${r.name} — ${LABEL[r.status]}`)}
					onmouseleave={() => clear_highlight()}
					onclick={() => press(r)}
					title={r.snap && r.status !== 'clean' ? 'show the difference' : "open the island's card"}
				>
					<td><span class="badge {r.status}">{LABEL[r.status]}</span></td>
					<!-- the name is a button: Tab reaches the row, Enter presses it (the press bubbles to the row) -->
					<td class="nm"><button class="rowbtn" onfocus={() => highlight([r.el], `${r.name} — ${LABEL[r.status]}`)} onblur={() => clear_highlight()}>{r.name}</button><span class="muted"> {r.wake}</span></td>
					<td class="why" title={r.reason}>{r.reason}{#if r.snap && r.status !== 'clean'}<span class="muted"> · click for the difference</span>{/if}</td>
				</tr>
				{#if open_el === r.el && diff}
					<tr class="diffrow">
						<td colspan="3">
							<p class="muted">server markup against the browser's first render: <b class="del">−{diff.removed}</b> <b class="add">+{diff.added}</b> pieces{diff.partial ? ' (too many changes: only where they start)' : ''}</p>
							{#if r.snap?.from !== undefined}<p class="muted" data-og-hyd-window>A big island: this is the part around its first change, about {Math.round(r.snap.from / 1024)} KB into its markup — later changes are not shown.</p>{/if}
							{#each diff.hunks as h, i (i)}
								<div class="hunk">
									{#each h.ops as o, k (k)}<span class={o.op}>{o.text}</span>{/each}
								</div>
							{/each}
							{#if !diff.hunks.length}<p class="muted">No visible difference (only Svelte's markers moved).</p>{/if}
						</td>
					</tr>
				{/if}
			{:else}
				<tr><td class="muted">no islands on this page</td></tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.hy {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.cap {
		font-size: 12px;
		color: #5eead4;
	}
	.muted {
		color: #94a3b8;
	}
	.counts {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	.badge {
		display: inline-block;
		font-size: 10px;
		padding: 1px 7px;
		border-radius: 999px;
		border: 1px solid rgba(148, 163, 184, 0.3);
		white-space: nowrap;
	}
	.badge.failed,
	.badge.recovered {
		background: rgba(239, 68, 68, 0.18);
		color: #fca5a5;
		border-color: rgba(239, 68, 68, 0.4);
	}
	.badge.healed,
	.badge.changed {
		background: rgba(245, 158, 11, 0.16);
		color: #fcd34d;
		border-color: rgba(245, 158, 11, 0.4);
	}
	.badge.clean {
		color: #86efac;
		border-color: rgba(34, 197, 94, 0.35);
	}
	.badge.asleep {
		color: #94a3b8;
	}
	table {
		border-collapse: collapse;
		width: 100%;
	}
	td {
		padding: 3px 4px;
		border-bottom: 1px solid rgba(148, 163, 184, 0.08);
		vertical-align: top;
	}
	.row {
		cursor: pointer;
	}
	.row:hover td {
		background: rgba(148, 163, 184, 0.08);
	}
	.nm {
		white-space: nowrap;
	}
	/* a button that reads as the name it was */
	.rowbtn {
		all: unset;
		cursor: pointer;
	}
	.rowbtn:focus-visible {
		outline: 2px solid rgba(94, 234, 212, 0.7);
		outline-offset: 2px;
		border-radius: 3px;
	}
	.why {
		color: #cbd5e1;
		max-width: 320px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.diffrow td {
		background: rgba(15, 23, 42, 0.6);
	}
	.hunk {
		font-size: 10.5px;
		line-height: 1.6;
		padding: 5px 7px;
		margin: 4px 0;
		border-radius: 6px;
		background: rgba(148, 163, 184, 0.06);
		word-break: break-all;
	}
	.hunk .same {
		color: #94a3b8;
	}
	.hunk .del {
		background: rgba(239, 68, 68, 0.22);
		color: #fecaca;
		text-decoration: line-through;
	}
	.hunk .add {
		background: rgba(34, 197, 94, 0.2);
		color: #bbf7d0;
	}
	b.del {
		color: #fca5a5;
	}
	b.add {
		color: #86efac;
	}
</style>
