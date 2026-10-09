<script lang="ts">
	/**
	 * THE EXACT LINES: the app lines that cost the most, one row each, with the code on the line
	 * and every cost the profiler measured joined on it (CPU, bytes allocated, the GC they caused,
	 * bytes kept alive). The tables below rank functions; this ranks the line a person edits.
	 * Static markup: the first rows show, the rest sit in a <details>.
	 */
	import type { LedgerLine } from '../ledger.js';
	import { PATTERN_LABEL, type Pattern } from '../patterns.js';
	import { fmt_ms, fmt_bytes } from './format.js';
	import { row_href } from './row-anchor.svelte.js';

	let { lines, patterns = [], shown = 8, renders = 1, fns }: { lines: LedgerLine[]; patterns?: Pattern[]; shown?: number; renders?: number; fns?: string[] } = $props();
	// a line links to its function's row only when the functions table has that row
	const known = $derived(fns ? new Set(fns) : null);
	const linkable = (fn: string | undefined): fn is string => !!fn && (!known || known.has(fn));
	// CPU, bytes made and GC add up every profiled render: shown per render. What a render KEPT
	// comes from one extra render already, so it is shown as it is.
	const per = (x: number) => x / Math.max(1, renders);

	// the pattern recognised on a line, for its badge
	const pattern_at = $derived.by(() => {
		const m = new Map<string, Pattern>();
		for (const p of patterns) for (const s of p.sites) m.set(s.path + ':' + s.line, p);
		return m;
	});

	const top = $derived(lines.slice(0, shown));
	const rest = $derived(lines.slice(shown));
	const max_score = $derived(Math.max(...lines.map((l) => l.score), 0.01));
</script>

{#snippet row(l: LedgerLine)}
	<li class="line">
		<div class="head">
			<span class="bar" style="width:{Math.max(3, (l.score / max_score) * 100)}%"></span>
			{#if linkable(l.fn)}
				<a class="loc" href={row_href('fn:' + l.fn)} title={l.path + ':' + l.line}>{l.file}:{l.line}</a>
			{:else}
				<span class="loc" title={l.path + ':' + l.line}>{l.file}:{l.line}</span>
			{/if}
			{#if l.module}<span class="who" title="the build has no sourcemap: the line number is the built chunk's">in {l.module}</span>{/if}
			{#if l.who.length}<span class="who">{l.who.join(' · ')}</span>{/if}
			{#if pattern_at.get(l.path + ':' + l.line)}
				{@const p = pattern_at.get(l.path + ':' + l.line)!}
				<span class="tag" title={p.title}>{PATTERN_LABEL[p.kind]}</span>
			{/if}
		</div>
		{#if l.code}<code class="code">{l.code}</code>{/if}
		<div class="costs">
			{#if l.cpu_ms > 0}<span class="c cpu"><b>{fmt_ms(per(l.cpu_ms))} ms</b> CPU</span>{/if}
			{#if l.lib_ms > 0}
				<span class="c lib" title={(l.libs ?? []).map((x) => `${x.name}${x.pkg ? ' (' + x.pkg + ')' : ''}: ${fmt_ms(per(x.ms))} ms${x.shared ? `, split over ${x.shared} lines that call it` : ''}`).join('\n')}>
					<b>{fmt_ms(per(l.lib_ms))} ms</b> inside {(l.libs ?? []).map((x) => x.name).slice(0, 2).join(', ') || 'libraries'}
				</span>
			{/if}
			{#if l.alloc_bytes > 0}<span class="c alloc"><b>{fmt_bytes(per(l.alloc_bytes))}</b> made</span>{/if}
			{#if l.gc_ms > 0}<span class="c gc"><b>{fmt_ms(per(l.gc_ms))} ms</b> cleanup</span>{/if}
			{#if l.retained_bytes > 0}<span class="c kept"><b>{fmt_bytes(l.retained_bytes)}</b> kept</span>{/if}
			{#if l.mem_via}<span class="c" title="Made inside this package, which the line calls, after an await (no line of yours was running): charged to the line that calls it">memory: inside {l.mem_via}</span>{/if}
			{#if l.merged}<span class="c" title="V8 merged {l.merged.callee} into its caller and charged its time to line {l.merged.from}. Its share was moved back here, split by a render profiled with that merging turned off.">time moved from line {l.merged.from}</span>{/if}
			{#if l.mem_in_fn}<span class="c" title="Memory is measured per function, not per line. This function's memory is shown on its busiest line.">memory: whole function</span>{/if}
		</div>
	</li>
{/snippet}

<ol class="ledger">
	{#each top as l (l.path + ':' + l.line)}{@render row(l)}{/each}
</ol>
{#if rest.length}
	<details>
		<summary>{rest.length} more line{rest.length === 1 ? '' : 's'}</summary>
		<ol class="ledger">
			{#each rest as l (l.path + ':' + l.line)}{@render row(l)}{/each}
		</ol>
	</details>
{/if}

<style>
	.ledger {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.line {
		border: 1px solid var(--line);
		border-radius: 6px;
		background: var(--bg-sunken);
		padding: 8px 10px;
		min-width: 0;
	}
	.head {
		position: relative;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 10px;
		font-size: 12.5px;
	}
	/* how the line ranks against the worst one, a thin rule under the heading */
	.bar {
		position: absolute;
		left: 0;
		bottom: -3px;
		height: 2px;
		background: var(--c-orange);
		border-radius: 1px;
		opacity: 0.7;
	}
	.loc {
		font-family: ui-monospace, monospace;
		font-weight: 600;
		color: var(--text);
		word-break: break-all;
		text-decoration: none;
	}
	a.loc:hover {
		text-decoration: underline;
	}
	.who {
		color: var(--text-faint);
		font-size: 12px;
		font-family: ui-monospace, monospace;
		word-break: break-all;
	}
	.tag {
		font-size: 11px;
		color: var(--c-orange);
		border: 1px solid currentColor;
		border-radius: 999px;
		padding: 0 7px;
		line-height: 1.5;
	}
	.code {
		display: block;
		margin: 7px 0 6px;
		font-family: ui-monospace, monospace;
		font-size: 12px;
		color: var(--text-dim);
		white-space: pre-wrap;
		word-break: break-word;
	}
	.costs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		font-size: 12px;
		color: var(--text-faint);
	}
	.c b {
		font-weight: 600;
	}
	.cpu b,
	.lib b {
		color: var(--c-orange);
	}
	.alloc b,
	.gc b {
		color: var(--c-blue);
	}
	.kept b {
		color: var(--warn);
	}
	details {
		margin-top: 8px;
	}
	summary {
		cursor: pointer;
		font-size: 12.5px;
		color: var(--text-dim);
		margin-bottom: 8px;
	}
</style>
