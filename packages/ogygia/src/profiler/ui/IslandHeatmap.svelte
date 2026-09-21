<script lang="ts">
	/**
	 * THE ISLAND COST HEATMAP — one row per island, one column per cost: server render, markup
	 * bytes, props bytes, unique JS, hydration in the browser, time to its first interaction, the
	 * layout shift it caused. Each cell is shaded against its column's max, so the eye finds the
	 * island that is expensive in several ways at once. A `wake:'load'` island; click a column to
	 * sort by it.
	 */
	import type { IslandRow } from './report-data.js';
	import type { Visit } from '../visit.js';
	import { fmt_bytes, fmt_ms } from './format.js';

	let { rows, visit = null }: { rows: IslandRow[]; visit?: Visit | null } = $props();

	interface Col {
		key: string;
		label: string;
		hint: string;
		get: (r: IslandRow) => number | null;
		fmt: (n: number) => string;
	}
	const firsts = $derived(new Map((visit?.firsts ?? []).map((f) => [f.fp, f.t])));
	const cls_by = $derived.by(() => {
		const m = new Map<string, number>();
		for (const s of visit?.shifts ?? []) if (s.fp) m.set(s.fp, (m.get(s.fp) ?? 0) + s.value);
		return m;
	});
	const visit_islands = $derived(new Map((visit?.islands ?? []).map((i) => [i.fp, i])));
	const all_cols: Col[] = $derived([
		{ key: 'ssr', label: 'server ms', hint: 'render time on the server, per render', get: (r) => r.ssr_ms, fmt: (n) => `${fmt_ms(n)}` },
		{ key: 'markup', label: 'markup', hint: 'the island’s HTML bytes', get: (r) => r.canonical_bytes || null, fmt: fmt_bytes },
		{ key: 'props', label: 'props', hint: 'the props tail bytes the browser downloads for it', get: (r) => r.props_bytes || null, fmt: fmt_bytes },
		{ key: 'js', label: 'JS', hint: 'the JS its wake loads (unique to it)', get: (r) => r.js_bytes, fmt: fmt_bytes },
		{ key: 'hydrate', label: 'hydrate ms', hint: 'wake to hydrated in your browser, p50', get: (r) => r.client?.p50_ms ?? null, fmt: (n) => `${fmt_ms(n)}` },
		{ key: 'woke', label: 'woke at', hint: 'when it finished hydrating in this visit, ms after the click', get: (r) => visit_islands.get(r.fp)?.done ?? null, fmt: (n) => `${fmt_ms(n)}` },
		{ key: 'first', label: 'first touch', hint: 'the first interaction inside it in this visit, ms after the click', get: (r) => firsts.get(r.fp) ?? null, fmt: (n) => `${fmt_ms(n)}` },
		{ key: 'cls', label: 'shift', hint: 'the layout shift its nodes caused in this visit (CLS share)', get: (r) => cls_by.get(r.fp) ?? null, fmt: (n) => n.toFixed(3) }
	]);
	// drop columns with no data at all (dev has no JS weights; the browser columns need a logged-in
	// visit) — a whole column of dashes is noise, not information
	const cols = $derived(all_cols.filter((c) => rows.some((r) => c.get(r) != null)));
	const max = $derived(cols.map((c) => Math.max(...rows.map((r) => c.get(r) ?? 0), 0)));
	let sort = $state<string | null>(null);
	const scored = $derived.by(() => {
		const score = (r: IslandRow) => cols.reduce((s, c, i) => s + (max[i] ? (c.get(r) ?? 0) / max[i] : 0), 0);
		const list = rows.map((r) => ({ r, score: score(r) }));
		if (sort) {
			const c = cols.find((x) => x.key === sort)!;
			list.sort((a, b) => (c.get(b.r) ?? -1) - (c.get(a.r) ?? -1));
		} else list.sort((a, b) => b.score - a.score);
		return list;
	});
	const shade = (v: number | null, i: number) => (v === null || !max[i] ? 'transparent' : `rgba(240, 136, 62, ${0.08 + 0.72 * (v / max[i])})`);
	const shown = $derived(scored.slice(0, 40));
</script>

<table class="heat">
	<thead>
		<tr>
			<th>island</th>
			{#each cols as c (c.key)}
				<th class="num col" class:on={sort === c.key} title={c.hint} onclick={() => (sort = sort === c.key ? null : c.key)}>{c.label}</th>
			{/each}
			<th class="num" title="how many of the columns it leads, summed as shares of each column’s max">cost</th>
		</tr>
	</thead>
	<tbody>
		{#each shown as { r, score } (r.entry)}
			<tr>
				<td class="fn"><b>{r.name}</b> <span class="hint">{r.wake}{r.copies > 1 ? ` ×${r.copies}` : ''}</span></td>
				{#each cols as c, i (c.key)}
					{@const v = c.get(r)}
					<td class="num cell" style="background:{shade(v, i)}">{v === null ? '—' : c.fmt(v)}</td>
				{/each}
				<td class="num"><b>{score.toFixed(1)}</b></td>
			</tr>
		{/each}
	</tbody>
</table>
<p class="hint">
	Darker is more of that cost, each column against its own biggest. An island dark across the row is the one to make static or wake later; one dark only in JS wants a smaller closure; one dark only in “first touch” could wake on interaction. Browser columns need a visit from this browser with the profiler logged in.
</p>

<style>
	.heat .col {
		cursor: pointer;
	}
	.heat .col.on {
		text-decoration: underline;
	}
	.heat .cell {
		font-variant-numeric: tabular-nums;
	}
</style>
