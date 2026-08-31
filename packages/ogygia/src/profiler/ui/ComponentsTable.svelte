<script lang="ts">
	/** Components table — a `wake:'load'` island with reactive column sort (was TABLE_SORT_JS + the
	 *  string row builder). Sorts by self/total/per-call/alloc. */
	import type { FrameStat } from '../analyze.js';
	import { fmt_ms, fmt_pct, fmt_bytes, CATEGORY_COLOR } from './format.js';
	import { sortable } from './sort.svelte.js';

	type Row = FrameStat & { per: number; count: number; alloc: number | null };
	let {
		rows,
		busy,
		hasAlloc,
		maxTotal
	}: { rows: Row[]; busy: number; hasAlloc: boolean; maxTotal: number } = $props();

	const s = sortable(() => rows, 'self_ms');
</script>

<table>
	<thead>
		<tr>
			<th>component</th>
			<th>file</th>
			<th>self / total</th>
			<th class="num sort" class:active={s.key === 'self_ms'} onclick={() => s.click('self_ms')}
				>self ms<span class="arr">{s.arrow('self_ms')}</span></th
			>
			<th class="num sort" class:active={s.key === 'total_ms'} onclick={() => s.click('total_ms')}
				>total ms<span class="arr">{s.arrow('total_ms')}</span></th
			>
			<th
				class="num sort"
				class:active={s.key === 'per'}
				title="total ÷ renders — the cost of a single render"
				onclick={() => s.click('per')}>per call<span class="arr">{s.arrow('per')}</span></th
			>
			<th class="num">% of busy</th>
			{#if hasAlloc}
				<th class="num sort" class:active={s.key === 'alloc'} onclick={() => s.click('alloc')}
					>alloc<span class="arr">{s.arrow('alloc')}</span></th
				>
			{/if}
		</tr>
	</thead>
	<tbody>
		{#each s.sorted as f (f.name + f.url)}
			<tr>
				<td class="fn">
					<b>{f.name}</b>
					{#if f.count > 1}
						<span class="hint" title="{f.count} renders, {fmt_ms(f.total_ms / f.count)} ms each"
							>×{f.count}</span
						>
					{/if}
				</td>
				<td class="file">
					{#if f.url}{f.url}{#if f.line > 0}:{f.line}{/if}{:else}<span class="hint">native</span
						>{/if}
				</td>
				<td class="split">
					<div
						class="split-bar"
						title="self {fmt_ms(f.self_ms)} ms of total {fmt_ms(f.total_ms)} ms"
					>
						<div class="tot" style="width:{((f.total_ms / maxTotal) * 100).toFixed(1)}%"></div>
						<div
							class="slf"
							style="width:{((f.self_ms / maxTotal) * 100).toFixed(
								1
							)}%;background:{CATEGORY_COLOR[f.category]}"
						></div>
					</div>
				</td>
				<td class="num"><b>{fmt_ms(f.self_ms)}</b></td>
				<td class="num">{fmt_ms(f.total_ms)}</td>
				<td class="num">{fmt_ms(f.per)}</td>
				<td class="num">{fmt_pct(f.total_ms, busy)}</td>
				{#if hasAlloc}<td class="num">{f.alloc ? fmt_bytes(f.alloc) : '—'}</td>{/if}
			</tr>
		{/each}
	</tbody>
</table>
