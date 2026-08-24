<script lang="ts">
	/** Waiting-by-function table — a `wake:'load'` island with reactive sort (count / wait ms). Where
	 *  the server WAITED (not computed), attributed to the function that started the I/O. */
	import { fmt_ms, kind_color } from './format.js';
	import { sortable } from './sort.svelte.js';

	type Row = { caller: string; kind: string; count: number; ms: number; open: number };
	let { rows, maxMs }: { rows: Row[]; maxMs: number } = $props();

	const s = sortable(() => rows, 'ms');
</script>

<table>
	<thead>
		<tr>
			<th>function</th>
			<th>kind</th>
			<th>wait</th>
			<th class="num sort" class:active={s.key === 'count'} onclick={() => s.click('count')}
				>count<span class="arr">{s.arrow('count')}</span></th
			>
			<th class="num sort" class:active={s.key === 'ms'} onclick={() => s.click('ms')}
				>wait ms<span class="arr">{s.arrow('ms')}</span></th
			>
		</tr>
	</thead>
	<tbody>
		{#each s.sorted as r (r.caller + '|' + r.kind)}
			<tr>
				<td class="fn">{r.caller}</td>
				<td>{r.kind}</td>
				<td class="split">
					<div class="split-bar" title="{fmt_ms(r.ms)} ms across {r.count} call{r.count > 1 ? 's' : ''}">
						<div
							class="slf"
							style="width:{((r.ms / maxMs) * 100).toFixed(1)}%;background:{kind_color(r.kind)}"
						></div>
					</div>
				</td>
				<td class="num"
					>{r.count}{#if r.open}<span class="warn"> ({r.open} open)</span>{/if}</td
				>
				<td class="num"><b>{fmt_ms(r.ms)}</b></td>
			</tr>
		{/each}
	</tbody>
</table>
