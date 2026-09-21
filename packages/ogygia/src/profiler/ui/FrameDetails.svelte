<script lang="ts">
	/**
	 * The expanded row under a function / component: WHERE it is (the full path, with line and
	 * column, openable in the editor when the path is absolute; on a dev server the source lines
	 * themselves) and HOW it was reached (its heaviest call stacks, nearest caller first).
	 * Rendered inside the table islands; plain markup.
	 */
	import type { FrameStat } from '../analyze.js';
	import { fmt_ms, CATEGORY_LABEL } from './format.js';

	let {
		f,
		colspan,
		base = '',
		dev = false
	}: { f: FrameStat; colspan: number; base?: string; dev?: boolean } = $props();

	const is_abs = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
	const location = $derived(
		f.path ? f.path + (f.line > 0 ? ':' + f.line + (f.col > 0 ? ':' + f.col : '') : '') : ''
	);
	// An absolute path (a dev server, a sourcemapped build on the same machine) opens in the editor.
	const editor_href = $derived(
		f.path && is_abs(f.path)
			? 'vscode://file/' + f.path + (f.line > 0 ? ':' + f.line + (f.col > 0 ? ':' + f.col : '') : '')
			: ''
	);
	const stacks = $derived(f.stacks ?? []);
	// THE HOT LINES: where inside the function the self time landed (V8's per-line ticks)
	const lines = $derived(f.lines ?? []);
	const lines_max = $derived(Math.max(...lines.map((l) => l.ms), 0.01));
	const heat = $derived(new Map(lines.map((l) => [l.line, l.ms / lines_max])));
	const last_hot = $derived(lines.length ? Math.max(...lines.map((l) => l.line)) : 0);
	const ms_at = (n: number) => lines.find((l) => l.line === n)?.ms ?? 0;
	let copied = $state(false);
	async function copy() {
		try {
			await navigator.clipboard.writeText(location);
			copied = true;
			setTimeout(() => (copied = false), 1200);
		} catch {
			/* no clipboard (insecure context) — the text is selectable */
		}
	}
	// SOURCE PEEK (dev server only): the lines around the position, from `<base>/source`.
	let peek = $state<{ start: number; line: number; lines: string[] } | null>(null);
	$effect(() => {
		if (!dev || !base || !f.path || !is_abs(f.path) || f.line <= 0) return;
		// widen the peek to the hot lines when they sit below the function's first line
		const to = last_hot > f.line ? `&to=${Math.min(last_hot, f.line + 60)}` : '';
		const url = `${base}/source?p=${encodeURIComponent(f.path)}&l=${f.line}${to}`;
		let live = true;
		fetch(url, { headers: { accept: 'application/json' } })
			.then((r) => (r.ok ? r.json() : null))
			.then((j) => {
				if (live && j && Array.isArray(j.lines)) peek = j;
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	});
</script>

<tr class="details">
	<td {colspan}>
		<div class="where">
			<span class="k">where</span>
			{#if location}
				<code class="loc">{location}</code>
				<button class="mini" onclick={copy}>{copied ? 'copied' : 'copy'}</button>
				{#if editor_href}<a class="mini" href={editor_href}>open in editor</a>{/if}
			{:else}
				<span class="hint">native — no source position</span>
			{/if}
			<span class="k">kind</span>
			<span>{f.pkg ? `${CATEGORY_LABEL[f.category]} · ${f.pkg}` : CATEGORY_LABEL[f.category]}</span>
		</div>
		{#if lines.length}
			<div class="hotlines">
				<span class="k">hot lines</span>
				{#each lines as l (l.line)}
					<span class="hl" title="{fmt_ms(l.ms)} ms of self time on line {l.line}">
						<i style="width:{Math.max(4, (l.ms / lines_max) * 60)}px"></i>
						<code>:{l.line}</code> <span class="dim">{fmt_ms(l.ms)} ms</span>
					</span>
				{/each}
			</div>
		{/if}
		{#if peek}
			<pre class="peek">{#each peek.lines as ln, i (i)}<span class="ln" class:hot={peek.start + i === peek.line} style={heat.has(peek.start + i) ? `background:rgba(232,115,74,${(0.12 + 0.5 * (heat.get(peek.start + i) ?? 0)).toFixed(2)})` : ''}><span class="no">{peek.start + i}</span><span class="lms">{heat.has(peek.start + i) ? fmt_ms(ms_at(peek.start + i)) : ''}</span>{ln}
</span>{/each}</pre>
		{/if}
		{#if stacks.length}
			<div class="stacks">
				{#each stacks as st, i (i)}
					<div class="stack">
						<div class="stack-h">
							<b>{fmt_ms(st.ms)} ms</b> came through this path
							{#if st.frames.length === 0}<span class="hint">(called at the top level)</span>{/if}
						</div>
						<ol>
							{#each st.frames as fr, j (j)}
								<li class:dim={fr.c !== 'app' && fr.c !== 'component'} title={fr.c}>
									<span class="n">{fr.n}</span>{#if fr.f}<span class="f">{fr.f}</span>{/if}
								</li>
							{/each}
						</ol>
					</div>
				{/each}
			</div>
		{:else}
			<p class="hint">No call stacks recorded for this row (an older report, or a frame with no callers).</p>
		{/if}
	</td>
</tr>

<style>
	tr.details td {
		background: var(--bg-raised);
		padding: 10px 14px 12px;
		border-bottom: 1px solid var(--line);
	}
	.where {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 10px;
		align-items: center;
		font-size: 12.5px;
		margin-bottom: 8px;
	}
	.k {
		color: var(--text-faint);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.loc {
		font-family: ui-monospace, monospace;
		font-size: 12px;
		color: var(--text);
		user-select: all;
		word-break: break-all;
	}
	.mini {
		font: inherit;
		font-size: 11px;
		color: var(--c-blue);
		background: var(--bg-hover);
		border: 1px solid var(--line);
		border-radius: 4px;
		padding: 1px 7px;
		cursor: pointer;
		text-decoration: none;
	}
	.mini:hover {
		background: var(--bg-hover);
	}
	.peek {
		margin: 0 0 10px;
		padding: 6px 0;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: 6px;
		font-size: 11.5px;
		line-height: 1.5;
		overflow-x: auto;
	}
	.peek .ln {
		display: block;
		padding: 0 10px;
		white-space: pre;
	}
	.peek .ln.hot {
		background: var(--warn-deep);
	}
	.peek .no {
		display: inline-block;
		width: 3.5em;
		color: var(--text-faint);
		user-select: none;
	}
	.peek .lms {
		display: inline-block;
		width: 5em;
		color: var(--c-orange);
		font-size: 10.5px;
		user-select: none;
	}
	.hotlines {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		align-items: center;
		margin: 0 0 8px;
		font-size: 12px;
	}
	.hl {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.hl i {
		display: inline-block;
		height: 8px;
		background: var(--c-orange);
		border-radius: 2px;
	}
	.dim {
		color: var(--text-faint);
	}
	.stacks {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 10px;
	}
	.stack {
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 8px 10px;
		min-width: 0;
	}
	.stack-h {
		font-size: 12px;
		color: var(--text-dim);
		margin-bottom: 4px;
	}
	ol {
		margin: 0;
		padding: 0 0 0 18px;
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
		line-height: 1.55;
	}
	li {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.n {
		color: var(--text);
	}
	/* framework / runtime frames between your own: kept (they are the truth of the path), dimmed */
	li.dim .n {
		color: var(--text-faint);
	}
	.f {
		color: var(--text-faint);
		margin-left: 8px;
	}
	.hint {
		color: var(--text-faint);
		font-size: 12px;
	}
</style>
