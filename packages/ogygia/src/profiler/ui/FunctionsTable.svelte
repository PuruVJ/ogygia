<script lang="ts">
	/** Hot-functions table — a `wake:'load'` island with reactive column sort, a name/file filter,
	 *  and an expandable row per function (full location + its heaviest call stacks). */
	import type { FrameStat } from '../analyze.js';
	import { fmt_ms, fmt_bytes, CATEGORY_COLOR, CATEGORY_LABEL } from './format.js';
	import { sortable } from './sort.svelte.js';
	import FrameDetails from './FrameDetails.svelte';

	type Row = FrameStat & { per: number; count: number; alloc: number | null };
	let { rows, hasAlloc }: { rows: Row[]; hasAlloc: boolean } = $props();

	let query = $state('');
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return rows;
		return rows.filter(
			(r) =>
				r.name.toLowerCase().includes(q) ||
				r.url.toLowerCase().includes(q) ||
				(r.path ?? '').toLowerCase().includes(q) ||
				(r.pkg ?? '').toLowerCase().includes(q)
		);
	});
	const s = sortable(() => filtered, 'self_ms');
	const row_key = (f: Row) => f.key ?? f.name + ' ' + f.url;
	let open = $state<string | null>(null);
	const cols = $derived(hasAlloc ? 7 : 6);
</script>

<div class="tools">
	<input
		type="search"
		placeholder="filter by function, file or package…"
		bind:value={query}
		aria-label="filter functions"
	/>
	<span class="hint">{filtered.length} of {rows.length} · click a row for its location and call stacks</span>
</div>
<table>
	<thead>
		<tr>
			<th>function</th>
			<th>where</th>
			<th></th>
			<th class="num sort" class:active={s.key === 'self_ms'} onclick={() => s.click('self_ms')}
				>self ms<span class="arr">{s.arrow('self_ms')}</span></th
			>
			<th class="num sort" class:active={s.key === 'total_ms'} onclick={() => s.click('total_ms')}
				>total ms<span class="arr">{s.arrow('total_ms')}</span></th
			>
			<th
				class="num sort"
				class:active={s.key === 'per'}
				title="total ÷ calls — the cost of a single call"
				onclick={() => s.click('per')}>per call<span class="arr">{s.arrow('per')}</span></th
			>
			{#if hasAlloc}
				<th class="num sort" class:active={s.key === 'alloc'} onclick={() => s.click('alloc')}
					>alloc<span class="arr">{s.arrow('alloc')}</span></th
				>
			{/if}
		</tr>
	</thead>
	<tbody>
		{#each s.sorted as f (row_key(f))}
			<tr
				class="row"
				class:open={open === row_key(f)}
				onclick={() => (open = open === row_key(f) ? null : row_key(f))}
			>
				<td class="fn">
					<span class="caret">{open === row_key(f) ? '▾' : '▸'}</span>
					<b>{f.name}</b>
					{#if f.count > 1}
						<span class="hint" title="{f.count} calls, {fmt_ms(f.total_ms / f.count)} ms each"
							>×{f.count}</span
						>
					{/if}
				</td>
				<td class="file" title={f.path || ''}>
					{#if f.url}{f.url}{#if f.line > 0}:{f.line}{#if f.col > 0}:{f.col}{/if}{/if}{:else}<span
							class="hint">native</span
						>{/if}
				</td>
				<td
					><span
						class="chip"
						style="background:{CATEGORY_COLOR[f.category]}"
						title={f.pkg ? `${CATEGORY_LABEL[f.category]} · ${f.pkg}` : CATEGORY_LABEL[f.category]}
						>{f.pkg ?? CATEGORY_LABEL[f.category]}</span
					></td
				>
				<td class="num"><b>{fmt_ms(f.self_ms)}</b></td>
				<td class="num">{fmt_ms(f.total_ms)}</td>
				<td class="num">{fmt_ms(f.per)}</td>
				{#if hasAlloc}<td class="num">{f.alloc ? fmt_bytes(f.alloc) : '—'}</td>{/if}
			</tr>
			{#if open === row_key(f)}
				<FrameDetails {f} colspan={cols} />
			{/if}
		{/each}
	</tbody>
</table>

<style>
	.tools {
		display: flex;
		gap: 12px;
		align-items: center;
		flex-wrap: wrap;
		margin: 6px 0 8px;
	}
	.tools input {
		font: inherit;
		font-size: 13px;
		background: #12161c;
		color: #d8dee6;
		border: 1px solid #2b3340;
		border-radius: 6px;
		padding: 5px 10px;
		min-width: 280px;
	}
	.tools .hint {
		color: #7d8590;
		font-size: 12px;
	}
	tr.row {
		cursor: pointer;
	}
	tr.row:hover td {
		background: #12161c;
	}
	tr.row.open td {
		border-bottom-color: transparent;
	}
	.caret {
		color: #7d8590;
		font-size: 10px;
		margin-right: 4px;
	}
</style>
