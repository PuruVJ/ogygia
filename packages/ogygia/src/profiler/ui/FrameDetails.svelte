<script lang="ts">
	/**
	 * The expanded row under a function / component: WHERE it is (the full path, with line and
	 * column, openable in the editor when the path is absolute) and HOW it was reached (its
	 * heaviest call stacks, nearest caller first). Rendered inside the table islands; plain markup.
	 */
	import type { FrameStat } from '../analyze.js';
	import { fmt_ms, CATEGORY_LABEL } from './format.js';

	let { f, colspan }: { f: FrameStat; colspan: number } = $props();

	const location = $derived(
		f.path ? f.path + (f.line > 0 ? ':' + f.line + (f.col > 0 ? ':' + f.col : '') : '') : ''
	);
	// An absolute path (a dev server, a sourcemapped build on the same machine) opens in the editor.
	const editor_href = $derived(
		f.path && (f.path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(f.path))
			? 'vscode://file/' + f.path + (f.line > 0 ? ':' + f.line + (f.col > 0 ? ':' + f.col : '') : '')
			: ''
	);
	const stacks = $derived(f.stacks ?? []);
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
		background: #12161c;
		padding: 10px 14px 12px;
		border-bottom: 1px solid #232a35;
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
		color: #7d8590;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.loc {
		font-family: ui-monospace, monospace;
		font-size: 12px;
		color: #d8dee6;
		user-select: all;
		word-break: break-all;
	}
	.mini {
		font: inherit;
		font-size: 11px;
		color: #6cb2ff;
		background: #1a212b;
		border: 1px solid #2b3340;
		border-radius: 4px;
		padding: 1px 7px;
		cursor: pointer;
		text-decoration: none;
	}
	.mini:hover {
		background: #232b37;
	}
	.stacks {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 10px;
	}
	.stack {
		background: #0f1318;
		border: 1px solid #1e232b;
		border-radius: 6px;
		padding: 8px 10px;
		min-width: 0;
	}
	.stack-h {
		font-size: 12px;
		color: #aeb6c2;
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
		color: #d8dee6;
	}
	/* framework / runtime frames between your own: kept (they are the truth of the path), dimmed */
	li.dim .n {
		color: #7d8590;
	}
	.f {
		color: #7d8590;
		margin-left: 8px;
	}
	.hint {
		color: #7d8590;
		font-size: 12px;
	}
</style>
