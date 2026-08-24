<script lang="ts">
	/** Hot-functions table — a `wake:'load'` island with reactive column sort. */
	import type { FrameStat } from '../analyze.js';
	import { fmt_ms, fmt_bytes, CATEGORY_COLOR, CATEGORY_LABEL } from './format.js';
	import { sortable } from './sort.svelte.js';

	type Row = FrameStat & { per: number; count: number; alloc: number | null };
	let { rows, hasAlloc }: { rows: Row[]; hasAlloc: boolean } = $props();

	const s = sortable(() => rows, 'self_ms');
</script>

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
		{#each s.sorted as f (f.name + f.url)}
			<tr>
				<td class="fn">
					<b>{f.name}</b>
					{#if f.count > 1}
						<span class="hint" title="{f.count} calls, {fmt_ms(f.total_ms / f.count)} ms each"
							>×{f.count}</span
						>
					{/if}
				</td>
				<td class="file">
					{#if f.url}{f.url}{#if f.line > 0}:{f.line}{/if}{:else}<span class="hint">native</span
						>{/if}
				</td>
				<td
					><span class="chip" style="background:{CATEGORY_COLOR[f.category]}"
						>{CATEGORY_LABEL[f.category]}</span
					></td
				>
				<td class="num"><b>{fmt_ms(f.self_ms)}</b></td>
				<td class="num">{fmt_ms(f.total_ms)}</td>
				<td class="num">{fmt_ms(f.per)}</td>
				{#if hasAlloc}<td class="num">{f.alloc ? fmt_bytes(f.alloc) : '—'}</td>{/if}
			</tr>
		{/each}
	</tbody>
</table>
