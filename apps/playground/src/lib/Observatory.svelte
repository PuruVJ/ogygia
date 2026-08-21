<script>
	/**
	 * OBSERVATORY v0 — the browser compiler, first rung (internal/notes/devtools.md, Rung 1: "the
	 * observatory, no execution"). You type an ogygia component; a Web WORKER parses it with
	 * `svelte/compiler` (the same parser the Svelte REPL runs in-browser), finds the REAL marked-island
	 * imports, resolves the two dials to a strategy, and returns the ISLAND MAP + the transformed host.
	 * All heavy work is off the main thread, so the editor never blocks — and the worker is the seam the
	 * later rungs grow into (it becomes the in-browser SERVER realm). This component is itself an ogygia
	 * island, running under the playground's csr=false.
	 *
	 * SCOPE: marks + host rewrite are real (svelte/compiler + MagicString). The FULL ogygia transform
	 * (macros, `.ts` registries, free-var capture) additionally needs the oxc parser in-browser (native
	 * today — WASM / parser injection is the next step); region ids shown are an illustrative hash.
	 */
	const DEFAULT_SOURCE = `<scr${''}ipt>
  import Counter from './Counter.svelte' with { wake: 'load' };
  import Menu from './Menu.svelte' with { wake: 'interaction' };
  import Chart from './Chart.svelte' with { wake: 'visible' };
  import Greeting from './Greeting.svelte' with { render: 'deferred' };
  import Prose from './Prose.svelte' with { wake: 'none' };
  import Row from './Row.svelte' with { region: 'raw' };

  // unmarked = free server HTML, ships no JS
  import Header from './Header.svelte';
</scr${''}ipt>

<Header />
<Counter start={0} />
<Menu />
<Chart data={points} />
<Greeting />
<Prose>{@html article}</Prose>`;

	let source = $state(DEFAULT_SOURCE);
	let analysis = $state({ ok: true, islands: [], output: DEFAULT_SOURCE });
	let busy = $state(false);

	// `worker` is $state so the debounce effect re-runs (and posts the first analysis) once it's set.
	let worker = $state(/** @type {Worker | null} */ (null));
	let seq = 0;
	let want = 0;

	// Boot the worker ONCE. This effect reads no reactive state, so it never re-runs (and never spawns
	// a second worker); the latest request id wins, so stale responses are dropped. Vite's spec-aligned
	// worker form: `new Worker(new URL(...), { type: 'module' })`.
	$effect(() => {
		const w = new Worker(new URL('./observatory.worker.ts', import.meta.url), { type: 'module' });
		w.onmessage = (/** @type {MessageEvent} */ e) => {
			if (e.data.id === want) {
				analysis = e.data.result;
				busy = false;
			}
		};
		worker = w;
		return () => w.terminate();
	});

	// Re-analyze on edit — debounced, off the main thread. Runs when `source` (or the worker) changes;
	// the initial run fires once the boot effect sets `worker`.
	$effect(() => {
		const src = source;
		const w = worker;
		if (!w) return;
		busy = true;
		const t = setTimeout(() => {
			want = ++seq;
			w.postMessage({ id: want, source: src });
		}, 140);
		return () => clearTimeout(t);
	});
</script>

<div class="obs" data-observatory>
	<header>
		<b>ogygia observatory</b>
		<span class="muted">· browser compiler (v0 · marks + host rewrite, in a worker)</span>
		{#if analysis.oxc}
			<span class="oxc" class:ok={analysis.oxc.ok} data-obs-oxc title={analysis.oxc.error || ''}>
				{analysis.oxc.engine}: {analysis.oxc.ok ? `parsed ${analysis.oxc.imports} imports ✓` : 'failed'}
			</span>
		{/if}
		{#if busy}<span class="busy">compiling…</span>{/if}
	</header>

	<div class="grid">
		<section class="editor">
			<div class="cap">component source</div>
			<textarea bind:value={source} spellcheck="false" data-obs-input></textarea>
		</section>

		<section class="out">
			<div class="cap">island map — {analysis.islands.length} marked {analysis.islands.length === 1 ? 'region' : 'regions'}</div>
			{#if !analysis.ok}
				<div class="err">parse error: {analysis.error}</div>
			{:else if analysis.islands.length === 0}
				<div class="muted pad">no marked imports — everything here is free server HTML.</div>
			{:else}
				<table data-obs-map>
					<thead><tr><th>binding</th><th>component</th><th>strategy</th><th>id</th></tr></thead>
					<tbody>
						{#each analysis.islands as i (i.id)}
							<tr>
								<td>{i.local}</td>
								<td class="muted">{i.component.split('/').pop()}</td>
								<td>
									<span class="badge" style:--c={i.strategy.color}>{i.strategy.kind}</span>
									<div class="detail muted">{i.strategy.detail}</div>
								</td>
								<td class="muted">{i.id}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}

			<div class="cap">transformed host</div>
			<pre data-obs-output>{analysis.output}</pre>
		</section>
	</div>
</div>

<style>
	.obs {
		font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
		color: #e2e8f0;
		background: #0b1220;
		border: 1px solid rgba(148, 163, 184, 0.25);
		border-radius: 12px;
		overflow: hidden;
	}
	header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		border-bottom: 1px solid rgba(148, 163, 184, 0.18);
		background: #0d1526;
	}
	header b {
		color: #5eead4;
	}
	.oxc {
		margin-left: auto;
		padding: 2px 8px;
		border-radius: 999px;
		background: rgba(239, 68, 68, 0.15);
		color: #fca5a5;
		font-size: 11px;
	}
	.oxc.ok {
		background: rgba(20, 184, 166, 0.16);
		color: #5eead4;
	}
	.busy {
		color: #fbbf24;
	}
	.muted {
		color: #64748b;
	}
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		min-height: 460px;
	}
	.editor {
		border-right: 1px solid rgba(148, 163, 184, 0.18);
		display: flex;
		flex-direction: column;
	}
	.cap {
		padding: 6px 14px;
		color: #94a3b8;
		font-weight: 600;
		border-bottom: 1px solid rgba(148, 163, 184, 0.12);
		background: rgba(148, 163, 184, 0.05);
	}
	textarea {
		flex: 1;
		resize: none;
		border: 0;
		outline: 0;
		padding: 12px 14px;
		background: transparent;
		color: #e2e8f0;
		font: inherit;
		tab-size: 2;
		min-height: 240px;
	}
	.out {
		display: flex;
		flex-direction: column;
		overflow: auto;
	}
	table {
		border-collapse: collapse;
		width: 100%;
	}
	th,
	td {
		text-align: left;
		padding: 5px 14px;
		vertical-align: top;
	}
	thead th {
		color: #94a3b8;
		border-bottom: 1px solid rgba(148, 163, 184, 0.15);
		font-weight: 600;
	}
	tbody tr + tr td {
		border-top: 1px solid rgba(148, 163, 184, 0.08);
	}
	.badge {
		padding: 1px 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--c) 20%, transparent);
		color: var(--c);
		font-weight: 600;
		white-space: nowrap;
	}
	.detail {
		margin-top: 2px;
		font-size: 11px;
	}
	pre {
		margin: 0;
		padding: 12px 14px;
		white-space: pre-wrap;
		word-break: break-word;
		color: #cbd5e1;
	}
	.err {
		padding: 12px 14px;
		color: #fca5a5;
	}
	.pad {
		padding: 12px 14px;
	}
</style>
