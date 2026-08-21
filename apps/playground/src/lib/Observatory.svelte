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

	// A few example components to explore the compiler with.
	const PRESETS = {
		'all strategies': DEFAULT_SOURCE,
		counter: `<scr${''}ipt>
  import Counter from './Counter.svelte' with { wake: 'load' };
</scr${''}ipt>

<h1>Hello</h1>
<Counter start={0} />`,
		'server island': `<scr${''}ipt>
  // fetched from a signed endpoint after load; ships no JS of its own
  import Greeting from './Greeting.svelte' with { render: 'deferred' };
</scr${''}ipt>

<Greeting>
  {#snippet ogygiaFallback()}<p>loading…</p>{/snippet}
</Greeting>`,
		'lake in island': `<scr${''}ipt>
  import Card from './Card.svelte' with { wake: 'visible' };
  import Prose from './Prose.svelte' with { wake: 'none' };
</scr${''}ipt>

<Card>
  <Prose>{@html article}</Prose>
</Card>`
	};

	// Share via URL (Rung 6): load the source from the hash on mount, and keep the hash in sync so the
	// current URL always reproduces what you see. `#src=<uri-encoded source>`.
	function initial_source() {
		if (typeof location !== 'undefined' && location.hash.startsWith('#src=')) {
			try {
				return decodeURIComponent(location.hash.slice(5));
			} catch {
				/* malformed hash — fall back to the default */
			}
		}
		return DEFAULT_SOURCE;
	}

	let source = $state(initial_source());
	let analysis = $state({ ok: true, islands: [], output: source, real: false, realIslands: null });
	let busy = $state(false);
	let shared = $state(false);

	// Keep the hash in sync (replaceState → no history spam).
	$effect(() => {
		const src = source;
		const t = setTimeout(() => {
			try {
				history.replaceState(null, '', '#src=' + encodeURIComponent(src));
			} catch {
				/* noop */
			}
		}, 300);
		return () => clearTimeout(t);
	});

	async function share() {
		try {
			await navigator.clipboard.writeText(location.href);
			shared = true;
			setTimeout(() => (shared = false), 1200);
		} catch {
			/* clipboard blocked */
		}
	}
	let leg = $state('ssr'); // 'ssr' | 'client'
	let everWarmed = $state(false); // the WASM compiler needs ~1-2s to warm on first load

	$effect(() => {
		if (analysis.real || analysis.realError) everWarmed = true;
	});

	const shownOutput = $derived(
		leg === 'client' && analysis.outputClient ? analysis.outputClient : analysis.output
	);

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
		<span class="muted">· the real ogygia compiler, in your browser</span>
		{#if analysis.oxc}
			<span class="oxc" class:ok={analysis.oxc.ok} data-obs-oxc title={analysis.oxc.error || ''}>
				{analysis.oxc.engine}: {analysis.oxc.ok ? `parsed ${analysis.oxc.imports} imports ✓` : 'failed'}
			</span>
		{/if}
		{#if analysis.ms != null && analysis.real}<span class="ms" title="transform + svelte compile">{analysis.ms.toFixed(1)} ms</span>{/if}
		{#if busy}<span class="busy">compiling…</span>{/if}
	</header>

	<div class="grid">
		<section class="editor">
			<div class="cap">
				component source
				<span class="presets">
					{#each Object.entries(PRESETS) as [name, src]}
						<button onclick={() => (source = src)}>{name}</button>
					{/each}
					<button class="share" data-obs-share onclick={share}>{shared ? 'link copied ✓' : 'share'}</button>
				</span>
			</div>
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
								<td class="muted" title={i.real ? 'real md5 region id' : 'placeholder id (transform not yet run)'}>{i.id}{#if i.real}<span class="realdot" title="real ogygia region id">●</span>{/if}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}

			<div class="cap">
				transformed host
				{#if analysis.real}
					<span class="real" data-obs-real>real ogygia transform · {analysis.realIslands} islands</span>
				{:else}
					<span class="fallback" title={analysis.realError || ''}>mark-preview (real transform: {analysis.realError ? 'error' : 'n/a'})</span>
				{/if}
				{#if analysis.outputClient && analysis.outputClient !== analysis.output}
					<span class="legs" data-obs-legs>
						<button class:on={leg === 'ssr'} onclick={() => (leg = 'ssr')}>SSR leg</button>
						<button class:on={leg === 'client'} onclick={() => (leg = 'client')}>client leg</button>
					</span>
				{/if}
			</div>
			{#if !everWarmed}
				<div class="warming" data-obs-warming>warming the in-browser compiler (rolldown WASM)…</div>
			{/if}
			<pre data-obs-output>{shownOutput}</pre>

			{#if analysis.compiledServer}
				<details class="pipe" data-obs-compiled>
					<summary>▸ svelte-compiled server JS <span class="muted">· source → transform → svelte compile</span></summary>
					<pre class="msrc">{analysis.compiledServer}</pre>
				</details>
			{/if}

			{#if analysis.modules && analysis.modules.length}
				<div class="cap">generated modules <span class="muted">· what each island compiles to</span></div>
				<div class="mods" data-obs-modules>
					{#each analysis.modules as m (m.id)}
						<details>
							<summary>
								<span class="mono">{m.component}</span>
								<span class="mkind">{m.kind}</span>
								<span class="muted mono">{m.id.slice(0, 12)}</span>
							</summary>
							{#if m.wrapperSource}
								<div class="mpath">{m.wrapperPath}</div>
								<pre class="msrc">{m.wrapperSource}</pre>
							{/if}
							{#if m.entrySource}
								<div class="mpath">{m.entryPath}</div>
								<pre class="msrc">{m.entrySource}</pre>
							{/if}
							{#if !m.wrapperSource && !m.entrySource}
								<div class="muted mpath">no standalone module (rendered inline / binding-only)</div>
							{/if}
						</details>
					{/each}
				</div>
			{/if}
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
	.ms {
		margin-left: auto;
		color: #5eead4;
		font-size: 11px;
	}
	.busy {
		color: #fbbf24;
	}
	.presets {
		margin-left: auto;
		display: inline-flex;
		gap: 4px;
	}
	.presets button {
		padding: 2px 8px;
		border: 1px solid rgba(148, 163, 184, 0.25);
		background: #0d1526;
		color: #94a3b8;
		font: inherit;
		font-size: 10px;
		cursor: pointer;
		border-radius: 5px;
	}
	.presets button:hover {
		color: #e2e8f0;
		border-color: rgba(148, 163, 184, 0.5);
	}
	.presets .share {
		color: #5eead4;
		border-color: rgba(20, 184, 166, 0.4);
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
		display: flex;
		align-items: center;
		gap: 8px;
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
	.realdot {
		margin-left: 5px;
		color: #5eead4;
		font-size: 9px;
		vertical-align: 1px;
	}
	pre {
		margin: 0;
		padding: 12px 14px;
		white-space: pre-wrap;
		word-break: break-word;
		color: #cbd5e1;
	}
	.real {
		margin-left: 8px;
		padding: 1px 8px;
		border-radius: 999px;
		background: rgba(20, 184, 166, 0.16);
		color: #5eead4;
		font-weight: 600;
		font-size: 10px;
	}
	.fallback {
		margin-left: 8px;
		color: #64748b;
		font-weight: 400;
		font-size: 10px;
	}
	.legs {
		margin-left: auto;
		display: inline-flex;
		gap: 2px;
	}
	.legs button {
		padding: 2px 8px;
		border: 1px solid rgba(148, 163, 184, 0.25);
		background: #0d1526;
		color: #94a3b8;
		font: inherit;
		font-size: 10px;
		cursor: pointer;
		border-radius: 5px;
	}
	.legs button.on {
		background: #14b8a6;
		color: #022;
		border-color: #0d9488;
	}
	.pipe {
		margin: 4px 14px;
		border: 1px solid rgba(148, 163, 184, 0.15);
		border-radius: 6px;
		overflow: hidden;
	}
	.pipe summary {
		cursor: pointer;
		padding: 6px 10px;
		background: rgba(148, 163, 184, 0.05);
		user-select: none;
		color: #94a3b8;
	}
	.mods {
		padding: 4px 14px 14px;
	}
	.mods details {
		border: 1px solid rgba(148, 163, 184, 0.15);
		border-radius: 6px;
		margin: 6px 0;
		overflow: hidden;
	}
	.mods summary {
		cursor: pointer;
		padding: 6px 10px;
		display: flex;
		gap: 10px;
		align-items: center;
		background: rgba(148, 163, 184, 0.05);
		user-select: none;
	}
	.mono {
		font-family: ui-monospace, Menlo, monospace;
	}
	.mkind {
		padding: 0 7px;
		border-radius: 999px;
		background: rgba(20, 184, 166, 0.14);
		color: #5eead4;
		font-size: 10px;
	}
	.mpath {
		padding: 6px 10px 2px;
		color: #94a3b8;
		font-size: 10px;
	}
	.msrc {
		margin: 0;
		padding: 6px 10px 10px;
		white-space: pre-wrap;
		word-break: break-word;
		color: #cbd5e1;
		font-size: 11px;
		max-height: 220px;
		overflow: auto;
	}
	.warming {
		padding: 10px 14px;
		color: #fbbf24;
	}
	.err {
		padding: 12px 14px;
		color: #fca5a5;
	}
	.pad {
		padding: 12px 14px;
	}
</style>
