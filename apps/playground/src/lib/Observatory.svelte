<script>
	import { mount, unmount } from 'svelte';
	// svelte forbids STATIC `svelte/internal/*` imports in app code; load it at runtime for the linker.

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
	// The all-strategies host — every island kind in one file (imports stub on render, but the transform
	// shows them all). Kept as a preset.
	const ALL_STRATEGIES = `<scr${''}ipt>
  import Counter from './Counter.svelte' with { wake: 'load' };
  import Menu from './Menu.svelte' with { wake: 'interaction' };
  import Chart from './Chart.svelte' with { wake: 'visible' };
  import Greeting from './Greeting.svelte' with { render: 'deferred' };
  import Prose from './Prose.svelte' with { wake: 'none' };
  import Row from './Row.svelte' with { region: 'raw' };

  // unmarked = free server HTML, ships no JS
  import Header from './Header.svelte';

  const points = [3, 1, 4, 1, 5];
  const article = '<p>rendered prose</p>';
</scr${''}ipt>

<Header />
<Counter start={0} />
<Menu />
<Chart data={points} />
<Greeting />
<Prose>{@html article}</Prose>`;

	// The default MULTI-FILE app — renders for real (its imported components are provided).
	const FILES_DEMO = {
		'App.svelte': `<scr${''}ipt>
  import Header from './Header.svelte';
  import Counter from './Counter.svelte' with { wake: 'load' };
  import Prose from './Prose.svelte' with { wake: 'none' };
</scr${''}ipt>

<Header title="My ogygia app" />
<p>An interactive island (ships JS), then a frozen lake (no JS):</p>
<Counter start={3} />
<Prose>a server-only prose block</Prose>`,
		'Header.svelte': `<scr${''}ipt>let { title = 'Hi' } = $props();</scr${''}ipt>
<h1>{title}</h1>`,
		'Counter.svelte': `<scr${''}ipt>
  let { start = 0 } = $props();
  let n = $state(start);
</scr${''}ipt>
<button onclick={() => n++}>count is {n}</button>`,
		'Prose.svelte': `<scr${''}ipt>let { children } = $props();</scr${''}ipt>
<div class="prose">{@render children?.()}</div>`
	};

	// Presets are file MAPS (Rung 6 multi-file). Most are single-file (their imports stub on render).
	const PRESETS = {
		'demo app': FILES_DEMO,
		'all strategies': { 'App.svelte': ALL_STRATEGIES },
		counter: { 'App.svelte': `<scr${''}ipt>\n  import Counter from './Counter.svelte' with { wake: 'load' };\n</scr${''}ipt>\n\n<h1>Hello</h1>\n<Counter start={0} />`, 'Counter.svelte': FILES_DEMO['Counter.svelte'] },
		'server island': { 'App.svelte': `<scr${''}ipt>\n  import Greeting from './Greeting.svelte' with { render: 'deferred' };\n</scr${''}ipt>\n\n<Greeting />` }
	};

	// Share via URL (Rung 6): the whole file MAP round-trips through the hash `#files=<json>`.
	function initial_files() {
		if (typeof location !== 'undefined' && location.hash.startsWith('#files=')) {
			try {
				const parsed = JSON.parse(decodeURIComponent(location.hash.slice(7)));
				if (parsed && typeof parsed === 'object') return parsed;
			} catch {
				/* malformed — fall back to the demo */
			}
		}
		return { ...FILES_DEMO };
	}

	let files = $state(initial_files());
	let active = $state('App.svelte' in initial_files() ? 'App.svelte' : Object.keys(initial_files())[0]);
	let analysis = $state({ ok: true, islands: [], output: '', real: false, realIslands: null });
	let busy = $state(false);
	let shared = $state(false);

	function load_preset(map) {
		files = structuredClone(map);
		active = 'App.svelte' in map ? 'App.svelte' : Object.keys(map)[0];
	}
	function add_file() {
		const name = prompt('New file name (e.g. Widget.svelte)');
		if (name && !files[name]) {
			files[name] = `<h1>${name.replace(/\\.svelte$/, '')}</h1>`;
			active = name;
		}
	}
	function remove_file(name) {
		if (name === 'App.svelte') return; // keep an entry
		delete files[name];
		if (active === name) active = 'App.svelte' in files ? 'App.svelte' : Object.keys(files)[0];
	}

	// Keep the hash in sync (replaceState → no history spam).
	$effect(() => {
		const snap = $state.snapshot(files);
		const t = setTimeout(() => {
			try {
				history.replaceState(null, '', '#files=' + encodeURIComponent(JSON.stringify(snap)));
			} catch {
				/* noop */
			}
		}, 400);
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

	// Boot the worker ONCE (reads no reactive state → never spawns a second worker).
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

	// Re-analyze on edit — debounced, off the main thread. Reads the whole file map (deep) + active.
	$effect(() => {
		const snap = $state.snapshot(files);
		const a = active;
		const w = worker;
		if (!w) return;
		busy = true;
		const t = setTimeout(() => {
			want = ++seq;
			w.postMessage({ id: want, files: snap, active: a });
		}, 140);
		return () => clearTimeout(t);
	});

	// ── INTERACTIVE preview: link the CLIENT-compiled modules and mount() the app on the MAIN thread,
	// so the rendered app is actually interactive (the counter button works). Falls back to the SSR
	// HTML if the mount fails.
	let previewEl = $state(/** @type {HTMLElement | null} */ (null));
	let mounted = null;
	let svelteClient = $state(/** @type {any} */ (null));
	$effect(() => {
		import('svelte/internal/client')
			.then((m) => (svelteClient = m))
			.catch(() => {});
	});

	function eval_client(code, req) {
		const body = code
			.replace(/import\s+\*\s+as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const $1 = __require("$2");')
			.replace(/import\s+([\w$]+)\s*,\s*\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const __m_$1 = __require("$3"); const $1 = __m_$1.default; const {$2} = __m_$1;')
			.replace(/import\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const $1 = (__require("$2")).default;')
			.replace(/import\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const {$1} = __require("$2");')
			.replace(/import\s+['"][^'"]+['"]\s*;?/g, '')
			.replace(/export\s+default\s+/g, '__exports.default = ')
			.replace(/export\s*\{([^}]+)\}\s*;?/g, (_m, names) =>
				names.split(',').map((n) => { const p = n.trim().split(/\s+as\s+/); return `__exports[${JSON.stringify((p[1] || p[0]).trim())}] = ${p[0].trim()};`; }).join(' ')
			)
			.replace(/export\s+(const|let|var|function|class)\s+/g, '$1 ');
		const __exports = {};
		new Function('__require', '__exports', body)(req, __exports);
		return __exports;
	}

	$effect(() => {
		const client = analysis.client;
		const el = previewEl;
		const sc = svelteClient;
		if (!el) return;
		if (mounted) {
			try {
				unmount(mounted);
			} catch {
				/* noop */
			}
			mounted = null;
		}
		el.innerHTML = '';
		const fallback = () => {
			if (analysis.rendered?.ok && analysis.rendered.html) el.innerHTML = analysis.rendered.html;
		};
		if (!sc || !client || client.error || !client.modules?.[client.entry]) {
			fallback();
			return;
		}
		try {
			const cache = new Map();
			const resolveName = (spec) => {
				const bare = spec.replace(/^\.\//, '').replace(/^\//, '');
				if (client.modules[bare] != null) return bare;
				const base = spec.split('/').pop();
				return base && client.modules[base] != null ? base : null;
			};
			const require = (spec) => {
				if (spec === 'svelte/internal/client') return sc;
				const name = resolveName(spec);
				if (name) {
					if (cache.has(name)) return cache.get(name);
					const exports = {};
					cache.set(name, exports);
					Object.assign(exports, eval_client(client.modules[name], require));
					return exports;
				}
				return { default: () => {} }; // unprovided component → no-op client stub
			};
			const App = eval_client(client.modules[client.entry], require).default;
			mounted = mount(App, { target: el });
		} catch (e) {
			console.error('[observatory] interactive mount failed:', e);
			fallback();
		}
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
				<span class="presets" data-obs-presets>
					{#each Object.entries(PRESETS) as [name, map]}
						<button onclick={() => load_preset(map)}>{name}</button>
					{/each}
					<button class="share" data-obs-share onclick={share}>{shared ? 'link copied ✓' : 'share'}</button>
				</span>
			</div>
			<div class="filetabs" data-obs-filetabs>
				{#each Object.keys(files) as name (name)}
					<button class="filetab" class:on={active === name} onclick={() => (active = name)}>
						{name}
						{#if name !== 'App.svelte'}<span
								class="rm"
								role="button"
								tabindex="-1"
								title="remove"
								onclick={(e) => {
									e.stopPropagation();
									remove_file(name);
								}}
								onkeydown={() => {}}>×</span
							>{/if}
					</button>
				{/each}
				<button class="filetab add" title="add a file" onclick={add_file}>+</button>
			</div>
			<textarea bind:value={files[active]} spellcheck="false" data-obs-input></textarea>
		</section>

		<section class="out">
			{#if analysis.rendered}
				<div class="cap">
					rendered <span class="muted">· SSR HTML, executed in your browser</span>
					{#if analysis.rendered.stubs && analysis.rendered.stubs.length}
						<span class="stubnote" title="components not provided in this single-file REPL render as placeholders">{analysis.rendered.stubs.length} stubbed</span>
					{/if}
				</div>
				<!-- Interactive: the mount effect fills this (or falls back to SSR HTML). -->
				<div class="preview" bind:this={previewEl} data-obs-preview></div>
				{#if analysis.rendered.ok}
					<details class="pipe">
						<summary>▸ rendered HTML source (SSR)</summary>
						<pre class="msrc" data-obs-html>{analysis.rendered.html}</pre>
					</details>
				{:else if !analysis.client || analysis.client.error}
					<div class="err" data-obs-render-err>could not render: {analysis.rendered.error}</div>
				{/if}
			{/if}

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
	.filetabs {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		padding: 5px 10px;
		border-bottom: 1px solid rgba(148, 163, 184, 0.12);
	}
	.filetab {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px 9px;
		border-radius: 6px 6px 0 0;
		border: 1px solid transparent;
		background: none;
		color: #94a3b8;
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}
	.filetab.on {
		color: #5eead4;
		background: rgba(20, 184, 166, 0.1);
		border-color: rgba(148, 163, 184, 0.2);
		border-bottom-color: transparent;
	}
	.filetab .rm {
		color: #64748b;
		font-size: 13px;
		line-height: 1;
	}
	.filetab .rm:hover {
		color: #fca5a5;
	}
	.filetab.add {
		color: #64748b;
		font-weight: 700;
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
	.preview {
		margin: 8px 14px;
		padding: 14px;
		border: 1px dashed rgba(148, 163, 184, 0.3);
		border-radius: 8px;
		background: #fff;
		color: #111;
		max-height: 260px;
		overflow: auto;
	}
	.preview :global(.og-stub) {
		display: inline-block;
		padding: 0 6px;
		border-radius: 4px;
		background: rgba(20, 184, 166, 0.15);
		color: #0d9488;
		font: 11px ui-monospace, Menlo, monospace;
	}
	.stubnote {
		padding: 1px 8px;
		border-radius: 999px;
		background: rgba(148, 163, 184, 0.12);
		color: #94a3b8;
		font-size: 10px;
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
