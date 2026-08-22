<script lang="ts">
	import { mount, unmount, untrack } from 'svelte';
	// The devtools event bus — in "islands" mode the page's REAL runtime emits hydration events for our
	// injected regions; we tap the bus to show the true lifecycle story (Rung-0 layer → an instrument).
	import { add_sink } from 'ogygia/devtools';
	import CodeMirror from './CodeMirror.svelte';
	import FormattedCode from './FormattedCode.svelte';
	import FileTree from './observatory/FileTree.svelte';
	import { SplitPane } from '@neodrag/svelte/splitpane';
	import { warmPrettier, formatCode } from './prettier';
	import { parse as devalue_parse } from 'devalue';
	import './observatory-canvas.css'; // gentle, overridable native-element defaults (.og-canvas), shared with the iframe
	import type { Analysis } from './observatory.worker';
	// svelte forbids STATIC `svelte/internal/*` imports in app code; load it at runtime for the linker.

	/** A REPL project: a map of filename → source. */
	type FileMap = Record<string, string>;
	/** A component the linker builds from compiled client JS (raw svelte component fn). */
	type SvelteComp = (...args: unknown[]) => unknown;
	/** A linked module's exports (default is the component). */
	type Linked = { default?: SvelteComp } & Record<string, unknown>;
	/** A require() the linker feeds compiled modules (resolves bare + relative specifiers). */
	type Require = (spec: string) => Linked;
	/** One real-runtime lifecycle event, tapped off the devtools bus (islands mode). */
	type RuntimeEvent = { name: string; label: string; t?: number; ms?: number; when?: string };

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
	// ogygia is SvelteKit-only, so presets are shaped like real apps: a route `+page.svelte` entry, a
	// `+layout.ts` that opts the route into server-HTML (csr=false), and components under `$lib`.
	const LAYOUT_CSR = `// ogygia renders pages as server HTML; only marked islands ship JS.\nexport const csr = false;`;
	const ALL_STRATEGIES = `<scr${''}ipt>
  import Counter from '$lib/Counter.svelte' with { wake: 'load' };
  import Menu from '$lib/Menu.svelte' with { wake: 'interaction' };
  import Chart from '$lib/Chart.svelte' with { wake: 'visible' };
  import Greeting from '$lib/Greeting.svelte' with { render: 'deferred' };
  import Prose from '$lib/Prose.svelte' with { wake: 'none' };
  import Row from '$lib/Row.svelte' with { region: 'raw' };

  // unmarked = free server HTML, ships no JS
  import Header from '$lib/Header.svelte';

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
		'Header.svelte': `<scr${''}ipt>
	let { title = 'Hi' } = $props();
</scr${''}ipt>

<h1>{title}</h1>
`,
		'Counter.svelte': `<scr${''}ipt>
	let { start = 0 } = $props();
	let n = $state(start);
</scr${''}ipt>

<button onclick={() => n++}>count is {n}</button>
`,
		'Prose.svelte': `<scr${''}ipt>
	let { children } = $props();
</scr${''}ipt>

<div class="prose">
	{@render children?.()}
</div>
`
	};

	// A multi-file app with EVERY wake schedule, so the x-ray wake visualizer has something to show:
	// Counter wakes on load, Menu on interaction (click), Chart on scroll-into-view, Prose is a frozen lake.
	const FILES_WAKE = {
		'App.svelte': `<scr${''}ipt>
  import Header from './Header.svelte';
  import Counter from './Counter.svelte' with { wake: 'load' };
  import Menu from './Menu.svelte' with { wake: 'interaction' };
  import Chart from './Chart.svelte' with { wake: 'visible' };
  import Prose from './Prose.svelte' with { wake: 'none' };
</scr${''}ipt>

<Header title="Wake schedules" />
<p>Each island wakes on its own schedule. In x-ray: watch load fire, click Menu, scroll to Chart.</p>
<Counter start={0} />
<Menu />
<Chart data={[3, 1, 4, 1, 5, 9, 2, 6, 5, 3]} />
<Prose>a frozen lake — never ships JS, never wakes</Prose>`,
		'Header.svelte': FILES_DEMO['Header.svelte'],
		'Counter.svelte': FILES_DEMO['Counter.svelte'],
		'Prose.svelte': FILES_DEMO['Prose.svelte'],
		'Menu.svelte': `<scr${''}ipt>
	let open = $state(false);
</scr${''}ipt>

<button onclick={() => (open = !open)}>
	Menu {open ? '▲' : '▼'}
</button>

{#if open}
	<ul>
		<li>Profile</li>
		<li>Settings</li>
		<li>Log out</li>
	</ul>
{/if}
`,
		'Chart.svelte': `<scr${''}ipt>
	let { data = [] } = $props();
</scr${''}ipt>

<div class="chart">
	{#each data as v}
		<span style="height: {v * 6}px"></span>
	{/each}
</div>

<style>
	.chart {
		display: flex;
		gap: 3px;
		align-items: flex-end;
		height: 60px;
	}
	.chart span {
		width: 12px;
		background: #14b8a6;
		border-radius: 2px;
	}
</style>
`
	};

	// Presets are file MAPS (Rung 6 multi-file). Most are single-file (their imports stub on render).
	const PRESETS = {
		'demo app': {
			'src/routes/+layout.ts': LAYOUT_CSR,
			'src/routes/+page.svelte': `<scr${''}ipt>
  import Header from '$lib/Header.svelte';
  import Counter from '$lib/Counter.svelte' with { wake: 'load' };
  import Prose from '$lib/Prose.svelte' with { wake: 'none' };
</scr${''}ipt>

<Header title="My ogygia app" />
<p>An interactive island (ships JS), then a frozen lake (no JS):</p>
<Counter start={3} />
<Prose>a server-only prose block</Prose>`,
			'src/lib/Header.svelte': FILES_DEMO['Header.svelte'],
			'src/lib/Counter.svelte': FILES_DEMO['Counter.svelte'],
			'src/lib/Prose.svelte': FILES_DEMO['Prose.svelte'],
		},
		'wake demo': {
			'src/routes/+layout.ts': LAYOUT_CSR,
			'src/routes/+page.svelte': `<scr${''}ipt>
  import Header from '$lib/Header.svelte';
  import Counter from '$lib/Counter.svelte' with { wake: 'load' };
  import Menu from '$lib/Menu.svelte' with { wake: 'interaction' };
  import Chart from '$lib/Chart.svelte' with { wake: 'visible' };
  import Prose from '$lib/Prose.svelte' with { wake: 'none' };
</scr${''}ipt>

<Header title="Wake schedules" />
<p>Each island wakes on its own schedule. In x-ray: watch load fire, click Menu, scroll to Chart.</p>
<Counter start={0} />
<Menu />
<Chart data={[3, 1, 4, 1, 5, 9, 2, 6, 5, 3]} />
<Prose>a frozen lake — never ships JS, never wakes</Prose>`,
			'src/lib/Header.svelte': FILES_WAKE['Header.svelte'],
			'src/lib/Counter.svelte': FILES_WAKE['Counter.svelte'],
			'src/lib/Menu.svelte': FILES_WAKE['Menu.svelte'],
			'src/lib/Chart.svelte': FILES_WAKE['Chart.svelte'],
			'src/lib/Prose.svelte': FILES_WAKE['Prose.svelte'],
		},
		'all strategies': { 'src/routes/+layout.ts': LAYOUT_CSR, 'src/routes/+page.svelte': ALL_STRATEGIES },
		counter: {
			'src/routes/+layout.ts': LAYOUT_CSR,
			'src/routes/+page.svelte': `<scr${''}ipt>\n  import Counter from '$lib/Counter.svelte' with { wake: 'load' };\n</scr${''}ipt>\n\n<h1>Hello</h1>\n<Counter start={0} />`,
			'src/lib/Counter.svelte': FILES_DEMO['Counter.svelte'],
		},
		'server island': {
			'src/routes/+layout.ts': LAYOUT_CSR,
			'src/routes/+page.svelte': `<scr${''}ipt>
  import Header from '$lib/Header.svelte';
  import Greeting from '$lib/Greeting.svelte' with { render: 'deferred' };
</scr${''}ipt>

<Header title="Server islands" />
<p>The greeting is a server island: its HTML is FETCHED from a signed endpoint after load (not
inlined). In "islands" mode, watch the fallback swap for the real content.</p>
<Greeting name="Ada" unread={3} />`,
			'src/lib/Header.svelte': FILES_DEMO['Header.svelte'],
			'src/lib/Greeting.svelte': `<scr${''}ipt>
	let { name = 'friend', unread = 0 } = $props();
</scr${''}ipt>

<div class="greeting">
	👋 Welcome back, {name}. You have {unread} unread
	{unread === 1 ? 'message' : 'messages'}.
</div>
`
		},
		'live region': {
			'src/routes/+layout.ts': LAYOUT_CSR,
			'src/routes/+page.svelte': `<scr${''}ipt>
  import Header from '$lib/Header.svelte';
  import Ticker from '$lib/Ticker.svelte' with { render: 'live' };
</scr${''}ipt>

<Header title="Live regions" />
<p>The box below is a live region: its HTML re-renders and MORPHS in place (~every 1.5s). Type in the
input — your text and focus SURVIVE each update (that's the morph, not a re-mount).</p>
<Ticker />`,
			'src/lib/Header.svelte': FILES_DEMO['Header.svelte'],
			'src/lib/Ticker.svelte': `<scr${''}ipt>
	let { n = 0 } = $props();
</scr${''}ipt>

<div class="ticker">
	<div class="live">
		🔴 LIVE · re-rendered <b>{n}</b>
		{n === 1 ? 'time' : 'times'} on the server, morphed in place
	</div>
	<label>
		your text + caret survive every update →
		<input placeholder="click here and type…" />
	</label>
</div>

<style>
	.ticker {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
		border: 1px solid var(--obs-border);
		border-radius: 10px;
		background: var(--obs-panel);
	}
	.live {
		font-weight: 600;
	}
	.live b {
		color: var(--obs-accent);
	}
	label {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--obs-muted);
		font-size: 13px;
	}
	input {
		padding: 5px 9px;
		border: 1px solid var(--obs-border);
		border-radius: 6px;
	}
</style>
`
		},
		'keep · nav': {
			'src/routes/+layout.ts': LAYOUT_CSR,
			'src/routes/+page.svelte': `<scr${''}ipt>
  import Counter from '$lib/Counter.svelte' with { wake: 'load', keep: 'counter' };
  import HomeWidget from '$lib/HomeWidget.svelte' with { wake: 'load' };
</scr${''}ipt>

<nav style="display:flex; gap:12px; align-items:center; padding-bottom:8px; border-bottom:1px solid #e2e8f0;">
  <b>🏠 Home</b>
  <a href="/about" data-obs-nav="src/routes/about/+page.svelte">Go to About →</a>
</nav>
<p>The counter has <b>keep</b>. Bump it, then navigate — reconcile RELOCATES the live island, so its count survives. The widget below is page-specific (mounts/removes on nav).</p>
<Counter start={0} />
<HomeWidget />`,
			'src/routes/about/+page.svelte': `<scr${''}ipt>
  import Counter from '$lib/Counter.svelte' with { wake: 'load', keep: 'counter' };
  import AboutWidget from '$lib/AboutWidget.svelte' with { wake: 'load' };
</scr${''}ipt>

<nav style="display:flex; gap:12px; align-items:center; padding-bottom:8px; border-bottom:1px solid #e2e8f0;">
  <a href="/" data-obs-nav="src/routes/+page.svelte">← Back to Home</a>
  <b>ℹ️ About</b>
</nav>
<p>Same kept counter — its count survived the nav (the live island was relocated, not remounted). The widget is a different island now.</p>
<Counter start={0} />
<AboutWidget />`,
			'src/lib/Counter.svelte': `<scr${''}ipt>
	let { start = 0 } = $props();
	let n = $state(start);
</scr${''}ipt>

<button onclick={() => n++}>
	kept count: {n} — click me, then navigate
</button>
`,
			'src/lib/HomeWidget.svelte': `<scr${''}ipt>
	let n = $state(0);
</scr${''}ipt>

<div class="widget">
	🏠 Home widget (this island remounts per page) ·
	<button onclick={() => n++}>clicked {n}</button>
</div>

<style>
	.widget {
		margin-top: 8px;
		padding: 8px 12px;
		background: var(--obs-panel);
		border: 1px solid var(--obs-border);
		border-radius: 8px;
	}
</style>
`,
			'src/lib/AboutWidget.svelte': `<scr${''}ipt>
	let n = $state(0);
</scr${''}ipt>

<div class="widget">
	ℹ️ About widget (a different island) ·
	<button onclick={() => n++}>clicked {n}</button>
</div>

<style>
	.widget {
		margin-top: 8px;
		padding: 8px 12px;
		background: var(--obs-panel);
		border: 1px solid var(--obs-border);
		border-radius: 8px;
	}
</style>
`
		},
		// A realistic Kit codebase — FOLDERS (the tree earns its keep) — showing a held-raw region next to
		// an interactive island. `region: 'raw'` renders the component's HTML on the server and ships ZERO
		// JS for it (a registry the transform can't see into); the Counter beside it is a normal island.
		'raw region': {
			'src/routes/+layout.ts': `// ogygia renders pages as server HTML; only islands ship JS.\nexport const csr = false;`,
			'src/routes/+page.svelte': `<scr${''}ipt>
  import Counter from '$lib/Counter.svelte' with { wake: 'load' };
  import Badge from '$lib/Badge.svelte' with { region: 'raw' };
</scr${''}ipt>

<h1>Held-raw region</h1>
<p>The badge is a <b>held-raw</b> region — its HTML is rendered on the server and it ships
<b>no client module</b>. The counter next to it is a normal island (ships JS, interactive).</p>

<Counter start={0} />
<Badge label="raw" note="server HTML · zero JS" />`,
			'src/lib/Counter.svelte': FILES_DEMO['Counter.svelte'],
			'src/lib/Badge.svelte': `<scr${''}ipt>
	let { label = '', note = '' } = $props();
</scr${''}ipt>

<span class="badge">
	<b>🔒 {label}</b>
	<small>{note}</small>
</span>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
		padding: 6px 12px;
		border: 1px solid var(--obs-border);
		border-radius: 999px;
		background: var(--obs-panel);
	}
	small {
		color: var(--obs-muted);
	}
</style>
`
		}
	};

	// Share via URL (Rung 6): the whole file MAP round-trips through the URL HASH — which browsers never
	// send to a server, so a shared REPL (or one an agent hands the user) stays client-only. Encoded as
	// `#code=<base64url(gzip(json))>` via the built-in CompressionStream (Chrome 80 / FF 113 / Safari
	// 16.4). `#files=<uriComponent(json)>` (uncompressed) is still READ for old links + as the fallback
	// when CompressionStream is missing. The gzip format matches Node's zlib, so `ogygia mcp`'s
	// ogygia_observatory tool mints the same link.
	const b64url_encode = (bytes: Uint8Array): string => {
		let bin = '';
		for (const b of bytes) bin += String.fromCharCode(b);
		return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	};
	const b64url_decode = (b64: string): Uint8Array => {
		const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return bytes;
	};
	// The WHOLE workspace — files + UI state — is ONE opaque string after the hash: `#<base64url(gzip(json))>`.
	// No visible code=/f=/tab= params. The JSON is `{ f: files, a: active, t: tab, m: mode, c: cursor }`
	// (short keys). gunzip is auto-detected by the gzip magic bytes, so a CompressionStream-less browser
	// still round-trips (plain base64 of the utf8 JSON). Same gzip format as `ogygia mcp`'s link tool.
	type Workspace = { files: FileMap; active?: string; tab?: string; mode?: string; cursor?: number };
	async function encode_hash(w: Workspace): Promise<string> {
		const bytes = new TextEncoder().encode(JSON.stringify({ f: w.files, a: w.active, t: w.tab, m: w.mode, c: w.cursor }));
		if (typeof CompressionStream === 'undefined') return '#' + b64url_encode(bytes);
		const gz = new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
		return '#' + b64url_encode(gz);
	}
	async function decode_hash(hash: string): Promise<Workspace | null> {
		const s = hash.replace(/^#/, '');
		if (!s) return null;
		try {
			// legacy `#code=`/`#files=` links (files-only)
			if (s.startsWith('code=') || s.startsWith('files=')) {
				const map = s.startsWith('code=')
					? JSON.parse(await new Response(new Blob([b64url_decode(s.slice(5)) as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).text())
					: JSON.parse(decodeURIComponent(s.slice(6)));
				return map && typeof map === 'object' ? { files: map as FileMap } : null;
			}
			const raw = b64url_decode(s);
			const json =
				raw[0] === 0x1f && raw[1] === 0x8b && typeof DecompressionStream !== 'undefined'
					? await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
					: new TextDecoder().decode(raw);
			const obj = JSON.parse(json);
			if (!obj || typeof obj !== 'object') return null;
			return obj.f && typeof obj.f === 'object'
				? { files: obj.f as FileMap, active: obj.a, tab: obj.t, mode: obj.m, cursor: obj.c }
				: { files: obj as FileMap };
		} catch {
			/* malformed — caller falls back to the demo */
		}
		return null;
	}

	let files = $state<FileMap>(structuredClone(PRESETS['demo app']));
	let active = $state<string>('src/routes/+page.svelte');
	let hash_loaded = $state(false);
	let cursor = $state(0); // the editor's cursor offset — round-trips in the URL
	let initial_cursor = $state(0); // applied to the editor once, on load

	// Load the whole workspace from the single hash string on mount (async — gzip decode). Runs once.
	$effect(() => {
		const hash = typeof location !== 'undefined' ? location.hash : '';
		if (!hash || hash === '#') {
			hash_loaded = true;
			return;
		}
		decode_hash(hash)
			.then((w) => {
				if (!w) return;
				const map = w.files;
				if (map && Object.keys(map).length) {
					files = map;
					active = w.active && w.active in map ? w.active : 'App.svelte' in map ? 'App.svelte' : Object.keys(map)[0];
				}
				if (w.tab && ['preview', 'islands', 'bytes', 'wire', 'output'].includes(w.tab)) inspectorTab = w.tab as InspectorTab;
				if (w.mode === 'live' || w.mode === 'xray' || w.mode === 'islands') previewMode = w.mode;
				initial_cursor = Number(w.cursor) || 0;
				cursor = initial_cursor;
			})
			.finally(() => (hash_loaded = true));
	});
	let analysis = $state<Analysis>({ ok: true, islands: [], output: '', real: false, realIslands: null });
	let busy = $state(false);
	let shared = $state(false);

	function load_preset(map: FileMap) {
		files = structuredClone(map);
		active = entry_of(files); // open the page the preview renders, not the first file alphabetically
	}
	function add_file() {
		const name = prompt('New file path (folders allowed, e.g. lib/Widget.svelte)');
		if (name && !files[name]) {
			const base = name.split('/').pop() || name;
			files[name] = /\.svelte$/.test(name) ? `<h1>${base.replace(/\.svelte$/, '')}</h1>` : '';
			active = name;
		}
	}
	function remove_file(name: string) {
		if (name === entryFile) return; // never remove the render entry — nothing would render
		delete files[name];
		if (active === name) active = entryFile in files ? entryFile : Object.keys(files)[0];
	}

	// Prettify the active file (the Format button). The formatter is the shared lazy prettier ($lib/prettier).
	let formatting = $state(false);
	const warm_prettier = warmPrettier;
	async function prettify() {
		if (formatting) return;
		const name = active;
		formatting = true;
		try {
			const out = await formatCode(files[name], name);
			if (typeof out === 'string' && out !== files[name]) files[name] = out;
		} catch {
			/* a syntax error mid-edit — leave the source untouched */
		} finally {
			formatting = false;
		}
	}

	// The "rendered HTML source (SSR)" shows the REAL ogygia SSR shape — so strip the Observatory's own
	// x-ray instrumentation (`<ogygia-obs-island data-obs-* …>` → the real `<ogygia-region wake="…">`
	// shell) and svelte's SSR hydration anchors, then pretty-print it with the same prettier.
	function clean_ssr(html: string): string {
		return html
			.replace(/<ogygia-obs-island\b[^>]*\bdata-wake="([^"]*)"[^>]*>/g, '<ogygia-region wake="$1">')
			.replace(/<ogygia-obs-island\b[^>]*>/g, '<ogygia-region>')
			.replace(/<\/ogygia-obs-island>/g, '</ogygia-region>')
			.replace(/<!--\[[0-9-]*-->/g, '')
			.replace(/<!--\]-->/g, '')
			.replace(/<!---->/g, '');
	}
	let ssr_source = $state('');
	$effect(() => {
		const raw = analysis.rendered?.html;
		if (!raw) {
			ssr_source = '';
			return;
		}
		const cleaned = clean_ssr(raw);
		ssr_source = cleaned; // show immediately (unformatted) …
		let cancelled = false;
		warm_prettier()
			.then(({ format, plugins }) =>
				// `htmlWhitespaceSensitivity: 'ignore'` stops prettier dangling the `>` onto its own line to
				// preserve inline whitespace — gives clean open/close tags for a source view.
				format(cleaned, { parser: 'html', plugins, printWidth: 80, useTabs: true, htmlWhitespaceSensitivity: 'ignore', bracketSameLine: false })
			)
			.then((pretty) => {
				if (!cancelled && typeof pretty === 'string') ssr_source = pretty;
			})
			.catch(() => {
				/* keep the unformatted clean version */
			});
		return () => {
			cancelled = true;
		};
	});

	// Test seam: drive the active file's source without depending on the editor widget (the e2e used to
	// poke the old `<textarea>`; CodeMirror is a contenteditable, so tests get a stable get/set here).
	$effect(() => {
		(window as unknown as Record<string, unknown>).__OBS_SOURCE = {
			get: () => files[active],
			set: (t: string) => (files[active] = t)
		};
		return () => delete (window as unknown as Record<string, unknown>).__OBS_SOURCE;
	});

	// Keep the hash in sync (replaceState → no history spam): the gzipped files + the UI state. Holds off
	// until the incoming link has been read, so it can't clobber it.
	$effect(() => {
		const snap = $state.snapshot(files);
		const a = active;
		const tab = inspectorTab;
		const m = previewMode;
		const c = cursor;
		if (!hash_loaded) return;
		const t = setTimeout(() => {
			encode_hash({ files: snap, active: a, tab, mode: m, cursor: c })
				.then((h) => history.replaceState(null, '', h))
				.catch(() => {
					/* noop */
				});
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

	// Byte ledger helpers — the ogygia thesis, weighed live.
	const fmt_bytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

	// Pretty-print a real runtime event (islands mode) into a short human line.
	function fmt_event(e: RuntimeEvent) {
		switch (e.name) {
			case 'region.connected':
				return { icon: '◻', text: 'connected', cls: 'ev-dim' };
			case 'wake.scheduled':
				return { icon: '⏱', text: `scheduled · ${e.when || 'load'}`, cls: 'ev-dim' };
			case 'wake.fired':
				return { icon: '⚡', text: `woke · ${e.when || 'load'}`, cls: 'ev-wake' };
			case 'region.hydrate.start':
				return { icon: '↯', text: 'hydrating…', cls: 'ev-dim' };
			case 'region.hydrate.done':
				return { icon: '✓', text: `hydrated${e.ms != null ? ` · ${Math.round(e.ms)}ms` : ''}`, cls: 'ev-done' };
			case 'region.hydrate.failed':
				return { icon: '✗', text: 'hydrate failed', cls: 'ev-fail' };
			default:
				return { icon: '·', text: e.name.replace(/^region\.|^runtime\./, ''), cls: 'ev-dim' };
		}
	}
	const saved_pct = $derived(
		analysis.ledger && analysis.ledger.kitBytes > 0
			? Math.round((1 - analysis.ledger.ogygiaBytes / analysis.ledger.kitBytes) * 100)
			: 0
	);
	// Server-backed regions — `render: 'deferred'` (server hole) and `render: 'live'`. Their HTML comes
	// from the server, so the in-page LIVE mount can't drive them: a deferred hole never swaps past its
	// fallback, a live region never ticks. The `islands` mode DOES (worker renders, main thread pushes
	// ticks / serves the endpoint) — so when live mode holds one, we point the reader there.
	const server_regions = $derived(
		(analysis.islands ?? []).filter((i) => i.strategy.kind === 'server hole' || i.strategy.kind === 'live')
	);

	$effect(() => {
		if (analysis.real || analysis.realError) everWarmed = true;
	});

	// csr switch: false → ogygia islands; true → the app compiled as a csr=true Kit route (islands
	// stripped to plain, Kit hydrates the whole tree). Flips the transform output, the ledger emphasis,
	// and the preview (islands vs a single whole-app mount).
	let csr = $state(false);
	const shownOutput = $derived(
		csr && analysis.outputCsrTrue
			? analysis.outputCsrTrue
			: leg === 'client' && analysis.outputClient
				? analysis.outputClient
				: analysis.output
	);

	// `worker` is $state so the debounce effect re-runs (and posts the first analysis) once it's set.
	let worker = $state<Worker | null>(null);
	let seq = 0;
	let want = 0;
	// Live-region tick requests + nav page-render requests: correlate each reply back to its awaiter.
	let liveSeq = 0;
	const liveWaiters = new Map<number, (html: string) => void>();
	const pageWaiters = new Map<number, (rd: NonNullable<Analysis['realDom']> | null) => void>();

	/** Ask the worker to render ONE component (with props) → HTML, for a live tick. */
	function live_request(fileMap: FileMap, file: string, props: Record<string, unknown>): Promise<string> {
		const w = worker;
		if (!w) return Promise.resolve('');
		const id = --liveSeq; // negative ids: a separate space from the analyze counter
		return new Promise<string>((resolve) => {
			liveWaiters.set(id, resolve);
			w.postMessage({ id, type: 'live', files: fileMap, file, props });
		});
	}

	// Boot the worker ONCE (reads no reactive state → never spawns a second worker).
	$effect(() => {
		const w = new Worker(new URL('./observatory.worker.ts', import.meta.url), { type: 'module' });
		w.onmessage = (e: MessageEvent<{ id: number; type?: string; result?: Analysis; html?: string; realDom?: NonNullable<Analysis['realDom']> }>) => {
			if (e.data.type === 'live') {
				liveWaiters.get(e.data.id)?.(e.data.html ?? '');
				liveWaiters.delete(e.data.id);
				return;
			}
			if (e.data.type === 'page') {
				pageWaiters.get(e.data.id)?.(e.data.realDom ?? null);
				pageWaiters.delete(e.data.id);
				return;
			}
			if (e.data.id === want && e.data.result) {
				analysis = e.data.result;
				busy = false;
			}
		};
		worker = w;
		return () => w.terminate();
	});

	// Re-analyze on EDIT — debounced, off the main thread. The analysis is about the APP: it transforms
	// + renders the ENTRY page, so it depends on the file CONTENTS (`files`), not which file you're
	// viewing. Switching files in the tree is pure navigation — it must NOT recompile (no "compiling…").
	$effect(() => {
		const snap = $state.snapshot(files);
		const a = entryFile; // entry, not `active` — so a file-switch (view change) doesn't re-analyze
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
	let previewEl = $state<HTMLElement | null>(null);
	let mounted: ReturnType<typeof mount> | null = null;
	let svelteClient = $state<Record<string, unknown> | null>(null);
	let previewMode = $state<'live' | 'xray' | 'islands'>('live');
	// The right pane is a tabbed inspector (declutters what used to be 6 stacked sections).
	type InspectorTab = 'preview' | 'islands' | 'bytes' | 'wire' | 'output';
	let inspectorTab = $state<InspectorTab>('preview');
	// Mobile: a single pane at a time — the file tree, the editor, or the inspector.
	let mobilePane = $state<'files' | 'editor' | 'result'>('editor');
	// Desktop: the file tree can collapse to a thin strip to reclaim width for code + preview.
	let treeCollapsed = $state(false);

	// The render entry — the page the preview renders. ogygia is SvelteKit-only, so a route `+page.svelte`
	// is the entry; `App.svelte` stays as a fallback for older shared workspaces, then the first file.
	// Mirrors the worker's pick so the tree can protect the same file from removal.
	function entry_of(map: FileMap): string {
		const keys = Object.keys(map);
		return (
			keys.find((k) => /(^|\/)\+page\.svelte$/.test(k)) ??
			(keys.includes('App.svelte') ? 'App.svelte' : keys[0])
		);
	}
	const entryFile = $derived(entry_of(files));

	// Resizable panes (neodrag splitpane) — file tree | editor | inspector. Drag either gutter to
	// rebalance; on mobile the CSS overrides the flex layout back to one-pane-at-a-time (data-pane).
	// minSizes (per pane) keep a pane from collapsing to nothing.
	const split = new SplitPane({ axis: 'x', sizes: [0.55, 2, 2], minSizes: [0.12, 0.2, 0.2] });

	// Wire tab: show the DECODED props by default (devalue's [{...},ref] wire format is unreadable);
	// toggle to the raw encoded bytes (what actually crosses). Pretty-printed (indent 2 — often not one
	// line) and rendered in a readonly CodeMirror so it's syntax-highlighted.
	let wireDecoded = $state(true);
	function wire_display(payload: string): string {
		try {
			const v = wireDecoded ? devalue_parse(payload) : JSON.parse(payload);
			return JSON.stringify(v, null, 2);
		} catch {
			return payload;
		}
	}
	// REAL runtime events for the injected preview islands (islands mode), tapped off the devtools bus.
	let runtimeEvents = $state<RuntimeEvent[]>([]);
	$effect(() => {
		import('svelte/internal/client')
			.then((m) => (svelteClient = m))
			.catch(() => {});
	});

	// The isolated iframe (islands mode) talks to us over postMessage: it's ready (→ send the page),
	// relays a runtime event (→ the bus panel), requests a nav (→ render the target + post it back), or
	// reports the reconcile decision (→ the readout). Reconcile + hydration all happen IN the frame.
	$effect(() => {
		const iframe = frameEl;
		if (!iframe) return;
		const onMsg = (e: MessageEvent) => {
			const d = e.data;
			if (!d || d.__obs !== true || e.source !== iframe.contentWindow) return;
			if (d.obsType === 'ready') {
				frameReady = true;
				render_to_frame();
			} else if (d.obsType === 'event') {
				const ev = d.ev as { name?: string; fp?: string; t?: number; ms?: number; when?: string };
				runtimeEvents = [...runtimeEvents, { name: ev.name ?? '', label: (d.label as string) || ev.fp || '', t: ev.t, ms: ev.ms, when: ev.when }].slice(-60);
			} else if (d.obsType === 'navReq') {
				void navigate_frame(String(d.entry || ''));
			} else if (d.obsType === 'reconciled') {
				navInfo = { to: currentPage.replace(/\.svelte$/, ''), kept: d.kept ?? [], mounted: d.mounted ?? [], removed: d.removed ?? [] };
			}
		};
		window.addEventListener('message', onMsg);
		return () => {
			window.removeEventListener('message', onMsg);
			frameReady = false;
			clear_frame_live();
		};
	});
	// Re-send the page whenever the analysis changes while the frame is live (a debounced edit).
	$effect(() => {
		void analysis.realDom;
		void analysis.client;
		void csr; // flipping csr re-renders (islands ⇄ whole-app mount)
		if (in_frame(previewMode) && frameReady) render_to_frame();
	});

	// x-ray and islands are the SAME real render in the isolated iframe — x-ray just adds the boundary
	// lens overlay on top of the live islands (so the counter still increments, wakes fire for real).
	const in_frame = (m: string) => m === 'islands' || m === 'xray';
	// Toggle the lens WITHOUT re-rendering (a full render would reset the hydrated islands' state), so
	// flipping x-ray ⇄ islands is a pure overlay change on the same live DOM.
	$effect(() => {
		const xray = previewMode === 'xray';
		if (frameReady && in_frame(previewMode)) post_to_frame({ obsType: 'lens', on: xray });
	});

	// SERVER ISLANDS: the real runtime fetches a deferred region's `endpoint` (same-origin path) and
	// swaps in the response text. We patch fetch ONCE, scoped to `/__obs_defer/*` — everything else
	// passes straight through — and serve the worker-rendered HTML (with a small delay so the deferred
	// nature is visible: the fallback shows, then the content lands). This is the real defer flow.
	$effect(() => {
		if (typeof window === 'undefined' || window.__OBS_FETCH_PATCHED__) return;
		window.__OBS_FETCH_PATCHED__ = true;
		window.__OBS_DEFER__ = window.__OBS_DEFER__ || {};
		const orig = window.fetch.bind(window);
		window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const m = /\/__obs_defer\/([^/?#]+)/.exec(url);
			if (m) {
				const html = (window.__OBS_DEFER__ || {})[m[1]];
				if (html != null) {
					return new Promise((res) =>
						setTimeout(() => res(new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })), 260)
					);
				}
				return Promise.resolve(new Response('', { status: 404 }));
			}
			return orig(input, init);
		};
	});

	// Nav (keep · nav): the reconcile decision of the last navigation, for the readout.
	let navInfo = $state<{ to: string; kept: string[]; mounted: string[]; removed: string[] } | null>(null);
	let currentPage = $state('App.svelte');

	// ── ISOLATED IFRAME PREVIEW: "islands" mode renders in /observatory-frame — its OWN document +
	// ogygia runtime + svelte instance. We drive it over postMessage: send the compiled page, receive
	// runtime events, nav-link requests, and the reconcile decision. Full isolation from the host.
	let frameEl = $state<HTMLIFrameElement | null>(null);
	let frameReady = $state(false);
	let frameLiveTimers: ReturnType<typeof setInterval>[] = [];

	// The site ThemeToggle (in the top nav) owns the theme now — it writes `og-theme` + `data-theme`;
	// the preview iframe re-themes from the same-origin `storage` event (its Harness listens). So the
	// Observatory carries no theme control of its own.
	const post_to_frame = (msg: Record<string, unknown>) =>
		frameEl?.contentWindow?.postMessage({ __obs: true, ...msg }, location.origin);

	function clear_frame_live() {
		for (const t of frameLiveTimers) clearInterval(t);
		frameLiveTimers = [];
	}
	/** Drive each live region in the frame: render the tick on the worker, post the HTML to applyLive. */
	function arm_frame_live(rd: NonNullable<Analysis['realDom']>) {
		const liveFiles = untrack(() => $state.snapshot(files));
		for (const lr of rd.live || []) {
			let n = 0;
			const t = setInterval(async () => {
				n++;
				const html = await live_request(liveFiles, lr.file, { n });
				if (html) post_to_frame({ obsType: 'liveTick', fp: lr.fp, html });
			}, 1500);
			frameLiveTimers.push(t);
		}
	}
	// Per-island JS byte count (from the ledger), keyed by file name — the frame's lens stamps it on
	// each region so the boundary overlay can label "· 518 B JS" without re-deriving anything.
	function lens_bytes(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const f of analysis.ledger?.files ?? []) if (f.ships) out[f.name] = f.bytes;
		return out;
	}
	/** Send the CURRENT analysis's page to the frame (a full render). */
	function render_to_frame() {
		const client = analysis.client;
		if (!frameReady || !client || client.error) return;
		runtimeEvents = [];
		navInfo = null;
		currentPage = untrack(() => ('App.svelte' in files ? 'App.svelte' : active));
		clear_frame_live();
		// $state.snapshot → plain objects (postMessage structured-clone can't take a reactive proxy).
		if (csr) {
			// csr=true: mount the WHOLE app as one hydration root — Kit steps in, no islands.
			post_to_frame({ obsType: 'renderKit', modules: $state.snapshot(client.modules), entry: client.entry });
			return;
		}
		const rd = analysis.realDom;
		if (!rd?.ok || !rd.html) return;
		post_to_frame({ obsType: 'render', html: rd.html, modules: $state.snapshot(client.modules), deferred: $state.snapshot(rd.deferred ?? {}), xray: previewMode === 'xray', bytes: lens_bytes() });
		arm_frame_live(rd);
	}

	/** Ask the worker to render a nav TARGET page to real-island HTML. */
	function page_request(fileMap: FileMap, entry: string): Promise<NonNullable<Analysis['realDom']> | null> {
		const w = worker;
		if (!w) return Promise.resolve(null);
		const id = --liveSeq;
		return new Promise((resolve) => {
			pageWaiters.set(id, resolve);
			w.postMessage({ id, type: 'page', files: fileMap, entry });
		});
	}

	/** A nav link was clicked in the frame → render the target on the worker + post it for the frame to
	 *  reconcile (keep islands relocated with their live state; others mount/remove). */
	async function navigate_frame(entry: string) {
		const client = analysis.client;
		if (!client || client.error || entry === currentPage) return;
		const rd = await page_request(untrack(() => $state.snapshot(files)), entry);
		if (!rd?.ok || !rd.html) return;
		currentPage = entry;
		clear_frame_live();
		post_to_frame({ obsType: 'nav', html: rd.html, modules: $state.snapshot(client.modules), deferred: $state.snapshot(rd.deferred ?? {}), xray: previewMode === 'xray', bytes: lens_bytes() });
		arm_frame_live(rd);
	}

	function eval_client(code: string, req: Require): Linked {
		const body = code
			.replace(/import\s+\*\s+as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const $1 = __require("$2");')
			.replace(/import\s+([\w$]+)\s*,\s*\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const __m_$1 = __require("$3"); const $1 = __m_$1.default; const {$2} = __m_$1;')
			.replace(/import\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const $1 = (__require("$2")).default;')
			.replace(/import\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const {$1} = __require("$2");')
			.replace(/import\s+['"][^'"]+['"]\s*;?/g, '')
			.replace(/export\s+default\s+/g, '__exports.default = ')
			.replace(/export\s*\{([^}]+)\}\s*;?/g, (_m: string, names: string) =>
				names.split(',').map((n: string) => { const p = n.trim().split(/\s+as\s+/); return `__exports[${JSON.stringify((p[1] || p[0]).trim())}] = ${p[0].trim()};`; }).join(' ')
			)
			.replace(/export\s+(const|let|var|function|class)\s+/g, '$1 ');
		const __exports: Linked = {};
		new Function('__require', '__exports', body)(req, __exports);
		return __exports;
	}

	$effect(() => {
		const client = analysis.client;
		const el = previewEl;
		const sc = svelteClient;
		const mode = previewMode;
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
		// x-ray now shares the ISLANDS render — the real runtime in the iframe, with the boundary lens
		// overlaid there (below). The old in-page simulated x-ray (arm_wakes) is gone: real islands wake
		// on their real schedule and stay interactive. Both frame modes skip the in-page mount.
		// ISLANDS + X-RAY (real runtime) render in an ISOLATED <iframe> (/observatory-frame) — its own
		// document, its own ogygia runtime + svelte instance. The frame effect above drives it.
		if (in_frame(mode)) return;
		if (!sc || !client || client.error || !client.modules?.[client.entry]) {
			fallback();
			return;
		}
		try {
			const cache = new Map<string, Linked>();
			const resolveName = (spec: string): string | null => {
				const clean = spec.split('?')[0];
				const bare = clean.replace(/^\.\//, '').replace(/^\//, '');
				if (client.modules[bare] != null) return bare;
				const base = clean.split('/').pop();
				if (!base) return null;
				if (client.modules[base] != null) return base;
				// basename-tolerant: a folder-keyed module reached via alias / different relative path.
				return Object.keys(client.modules).find((k) => k.split('/').pop() === base) ?? null;
			};
			const require: Require = (spec) => {
				if (spec === 'svelte/internal/client') return sc as Linked;
				const name = resolveName(spec);
				if (name) {
					const hit = cache.get(name);
					if (hit) return hit;
					const exports: Linked = {};
					cache.set(name, exports);
					Object.assign(exports, eval_client(client.modules[name], require));
					return exports;
				}
				return { default: () => {} }; // unprovided component → no-op client stub
			};
			const App = eval_client(client.modules[client.entry], require).default;
			mounted = mount(App as never, { target: el });
		} catch (e) {
			console.error('[observatory] interactive mount failed:', e);
			fallback();
		}
	});
</script>

<div class="obs" data-observatory>
	<header class="obs-bar">
		<div class="obs-brand">
			<b>Observatory</b>
			<span class="obs-sub">ogygia, live in your browser</span>
		</div>

		<span class="presets" data-obs-presets>
			{#each Object.entries(PRESETS) as [name, map]}
				<button onclick={() => load_preset(map)}>{name}</button>
			{/each}
		</span>

		<div class="obs-bar-right">
			<span class="status" data-obs-status>
				<span class="busy" class:show={busy}>compiling…</span>
				{#if analysis.ms != null && analysis.real}<span class="ms" title="transform + svelte compile">{analysis.ms.toFixed(1)} ms</span>{/if}
			</span>
			<span class="csrswitch" data-obs-csr>
				<button class:on={!csr} onclick={() => (csr = false)} title="ogygia islands — only marked components ship JS">csr false</button>
				<button class:on={csr} onclick={() => (csr = true)} title="plain Kit — ogygia steps aside, the whole tree ships + hydrates">csr true</button>
			</span>
			<button class="share" data-obs-share onclick={share}>{shared ? 'copied ✓' : 'share'}</button>
		</div>
	</header>

	<!-- Mobile: one pane at a time -->
	<div class="obs-mobile-switch" role="tablist" aria-label="pane">
		<button class:on={mobilePane === 'files'} onclick={() => (mobilePane = 'files')}>Files</button>
		<button class:on={mobilePane === 'editor'} onclick={() => (mobilePane = 'editor')}>Editor</button>
		<button class:on={mobilePane === 'result'} onclick={() => (mobilePane = 'result')}>Result</button>
	</div>

	<div class="obs-main" data-pane={mobilePane} class:tree-collapsed={treeCollapsed} {...split.container}>
		<aside class="obs-tree-pane" class:collapsed={treeCollapsed} {...split.pane(0)}>
			{#if treeCollapsed}
				<button class="tree-reopen" title="show the file tree" onclick={() => (treeCollapsed = false)}>
					<span class="tr-arrow">»</span><span class="tr-label">files</span>
				</button>
			{:else}
				<FileTree
					{files}
					{active}
					entry={entryFile}
					onselect={(p) => (active = p)}
					onremove={remove_file}
					onadd={add_file}
					oncollapse={() => (treeCollapsed = true)}
				/>
			{/if}
		</aside>

		<div class="obs-gutter" {...split.gutter(0)} role="separator" aria-orientation="vertical" aria-label="resize file tree and editor"></div>

		<section class="obs-editor" {...split.pane(1)}>
			<div class="obs-editor-head" data-obs-editor-head>
				<span class="ehead-path" title={active}>{active}</span>
				<button
					class="fmt"
					data-obs-fmt
					title="Prettify (printWidth 60)"
					onmouseenter={warm_prettier}
					onfocus={warm_prettier}
					onclick={prettify}
					disabled={formatting}>{formatting ? '…' : 'Format'}</button
				>
			</div>
			<CodeMirror doc={files[active]} docKey={active} oninput={(v) => (files[active] = v)} oncursor={(o) => (cursor = o)} initialCursor={initial_cursor} />
		</section>

		<div class="obs-gutter" {...split.gutter(1)} role="separator" aria-orientation="vertical" aria-label="resize editor and inspector"></div>

		<section class="obs-inspector" {...split.pane(2)}>
			<div class="obs-tabs" role="tablist" aria-label="inspector">
				<button role="tab" class:on={inspectorTab === 'preview'} onclick={() => (inspectorTab = 'preview')}>Preview</button>
				<button role="tab" class:on={inspectorTab === 'islands'} onclick={() => (inspectorTab = 'islands')}>Regions{#if analysis.islands?.length}<span class="tcount">{analysis.islands.length}</span>{/if}</button>
				<button role="tab" class:on={inspectorTab === 'bytes'} onclick={() => (inspectorTab = 'bytes')}>Bytes</button>
				<button role="tab" class:on={inspectorTab === 'wire'} onclick={() => (inspectorTab = 'wire')}>Wire</button>
				<button role="tab" class:on={inspectorTab === 'output'} onclick={() => (inspectorTab = 'output')}>Output</button>
			</div>
			<div class="obs-tabbody">
			<div class="tp" class:on={inspectorTab === 'preview'} data-tab="preview">
			{#if analysis.rendered}
				<div class="cap">
					rendered
					<span class="muted">· {previewMode === 'live' ? 'live, interactive — mounted in your browser' : previewMode === 'xray' ? 'x-ray — the real runtime, with the boundary lens overlaid' : 'islands — the real ogygia runtime hydrates each region'}</span>
					{#if analysis.rendered.stubs && analysis.rendered.stubs.length}
						<span class="stubnote" title="components not provided in this single-file REPL render as placeholders">{analysis.rendered.stubs.length} stubbed</span>
					{/if}
					<span class="legs" data-obs-preview-mode>
						<button class:on={previewMode === 'live'} onclick={() => (previewMode = 'live')}>live</button>
						<button class:on={previewMode === 'xray'} onclick={() => (previewMode = 'xray')}>x-ray</button>
						<button class:on={previewMode === 'islands'} onclick={() => (previewMode = 'islands')} title="the page's real ogygia runtime hydrates the islands">islands</button>
					</span>
				</div>
				{#if previewMode === 'xray'}
					<div class="lens-legend" data-obs-legend>
						<span class="lk island">island · ships JS</span>
						<span class="lk hole">server hole</span>
						<span class="lk live">live</span>
						<span class="lk shell">the rest · free server HTML</span>
						<button class="replay" data-obs-replay title="re-render → islands re-hydrate on their schedule" onclick={() => render_to_frame()}>⟳ replay wakes</button>
					</div>
					<div class="wakehint muted">the <b>real runtime</b> — islands stay interactive. <b>load</b> woke now · <b>idle</b> soon · <b>visible</b> on scroll · <b>interaction</b> on click (dashed = still asleep).</div>
				{/if}
				{#if previewMode === 'live' && server_regions.length}
					<div class="wakehint srvhint" data-obs-server-hint>
						<b>{server_regions.map((i) => i.component.replace(/^.*\//, '').replace(/\.svelte$/, '')).join(', ')}</b>
						render on the <b>server</b> ({server_regions.some((i) => i.strategy.kind === 'live') ? 'live' : 'deferred'}).
						The in-page <b>live</b> mount can't drive them — a deferred hole never swaps, a live region never ticks.
						<button class="tolink" onclick={() => (previewMode = 'islands')}>switch to islands →</button>
						to watch the real runtime fetch and revalidate them.
					</div>
				{/if}
				{#if previewMode === 'islands'}
					<div class="wakehint muted" data-obs-islands-hint>
						the page's <b>real ogygia runtime</b> hydrated these — genuine <b>&lt;ogygia-region&gt;</b> shells,
						blob-linked island chunks, lazy per schedule. Try <b>keep · nav</b> (bump the counter, then navigate —
						its state survives the real reconcile) or <b>wake demo</b> (click Menu, scroll to Chart).
					</div>
				{/if}
				{#if in_frame(previewMode) && navInfo}
					<div class="navinfo" data-obs-navinfo>
						<span class="ni-cap">reconcile → <b>{navInfo.to}</b></span>
						{#if navInfo.kept.length}<span class="ni kept">kept {navInfo.kept.map((n) => n.replace(/\.svelte$/, '')).join(', ')}</span>{/if}
						{#if navInfo.mounted.length}<span class="ni mounted">mounted {navInfo.mounted.map((n) => n.replace(/\.svelte$/, '')).join(', ')}</span>{/if}
						{#if navInfo.removed.length}<span class="ni removed">removed {navInfo.removed.map((n) => n.replace(/\.svelte$/, '')).join(', ')}</span>{/if}
					</div>
				{/if}
				{#if in_frame(previewMode) && runtimeEvents.length}
					<div class="rtev" data-obs-runtime-events>
						<div class="rtev-cap">runtime events <span class="muted">· live from the devtools bus (Rung 0) as the real runtime hydrates</span></div>
						<div class="rtev-log">
							{#each runtimeEvents as e, i (i)}
								{@const f = fmt_event(e)}
								<div class="rtev-row {f.cls}">
									<span class="rtev-island mono">{e.label.replace(/\.svelte$/, '')}</span>
									<span class="rtev-icon">{f.icon}</span>
									<span class="rtev-text">{f.text}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}
				<!-- islands + x-ray → the ISOLATED iframe (own runtime/svelte/document), x-ray adds the lens
					 overlay there; live → the in-page whole-app mount. -->
				{#if in_frame(previewMode)}
					<iframe
						class="preview frame"
						bind:this={frameEl}
						src="/observatory-frame"
						title="isolated ogygia preview"
						data-obs-frame
					></iframe>
				{:else}
					<div class="preview og-canvas" bind:this={previewEl} data-obs-preview></div>
				{/if}
				{#if analysis.rendered.ok}
					<details class="pipe">
						<summary>rendered HTML source (SSR)</summary>
						<div class="code-out" data-obs-html><CodeMirror doc={ssr_source} lang="html" readonly /></div>
					</details>
				{:else if !analysis.client || analysis.client.error}
					<div class="err" data-obs-render-err>could not render: {analysis.rendered.error}</div>
				{/if}
			{/if}
			</div>

			<div class="tp" class:on={inspectorTab === 'bytes'} data-tab="bytes">
			{#if analysis.ledger && analysis.ledger.kitBytes > 0}
				<div class="cap">
					byte ledger <span class="muted">· island JS shipped vs plain Kit (csr=true)</span>
					{#if saved_pct > 0}<span class="saved" data-obs-saved>−{saved_pct}% JS</span>{/if}
				</div>
				<div class="ledger" data-obs-ledger>
					<div class="bars">
						<div class="barrow">
							<span class="blabel">ogygia</span>
							<div class="btrack">
								<div
									class="bfill og"
									style:width="{Math.max(2, (100 * analysis.ledger.ogygiaBytes) / analysis.ledger.kitBytes)}%"
								></div>
							</div>
							<span class="bnum og" data-obs-og-bytes
								>{fmt_bytes(analysis.ledger.ogygiaBytes)}
								<span class="muted">· {analysis.ledger.ogygiaCount} island{analysis.ledger.ogygiaCount === 1 ? '' : 's'}</span></span
							>
						</div>
						<div class="barrow">
							<span class="blabel">plain Kit</span>
							<div class="btrack">
								<div class="bfill kit" style:width="100%"></div>
							</div>
							<span class="bnum kit" data-obs-kit-bytes
								>{fmt_bytes(analysis.ledger.kitBytes)}
								<span class="muted">· {analysis.ledger.kitCount} component{analysis.ledger.kitCount === 1 ? '' : 's'}</span></span
							>
						</div>
					</div>
					<table class="ltable">
						<tbody>
							{#each analysis.ledger.files as f (f.name)}
								<tr class:ships={f.ships}>
									<td class="lname mono">{f.name}</td>
									<td class="lwhy muted">{f.why}</td>
									<td class="lbytes">{f.ships ? fmt_bytes(f.bytes) : '0 B'}<span class="lraw muted"> / {fmt_bytes(f.bytes)}</span></td>
								</tr>
							{/each}
						</tbody>
					</table>
					<div class="lfoot muted">
						uncompressed compiled JS · both share the svelte runtime (excluded) · ogygia adds its ~8&nbsp;KB
						island runtime, plain Kit hydrates the whole tree
					</div>
				</div>
			{/if}
			</div>

			<div class="tp" class:on={inspectorTab === 'wire'} data-tab="wire">
			{#if analysis.rendered?.wire && analysis.rendered.wire.length}
				<div class="cap">
					wire <span class="muted">· the props that cross to each island, by value (devalue)</span>
					<span class="legs wiretoggle" data-obs-wire-toggle>
						<button class:on={wireDecoded} onclick={() => (wireDecoded = true)} title="the props as JS values">decoded</button>
						<button class:on={!wireDecoded} onclick={() => (wireDecoded = false)} title="the raw devalue bytes that actually cross">encoded</button>
					</span>
				</div>
				<div class="wire" data-obs-wire>
					{#each analysis.rendered.wire as w, i (w.name + i)}
						<div class="wrow">
							<div class="wtop">
								<span class="wname mono">{w.name}</span>
								{#if !(w.payload === '{}' || w.payload === '[{},[]]' || w.payload === '[{}]')}<span class="wbytes muted">{w.bytes} B</span>{/if}
							</div>
							{#if w.payload === '{}' || w.payload === '[{},[]]' || w.payload === '[{}]'}
								<span class="muted wempty">no props cross — nothing to serialize</span>
							{:else}
								<div class="code-out"><CodeMirror doc={wire_display(w.payload)} lang="js" readonly /></div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
			</div>

			<div class="tp" class:on={inspectorTab === 'islands'} data-tab="islands">
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
			</div>

			<div class="tp" class:on={inspectorTab === 'output'} data-tab="output">
			<div class="cap">
				transformed host
				{#if csr}
					<span class="real csr-true" data-obs-real>csr=true · plain Kit — islands stripped to plain, Kit hydrates the whole tree</span>
				{:else if analysis.real}
					<span class="real" data-obs-real>real ogygia transform · {analysis.realIslands} islands</span>
				{:else}
					<span class="fallback" title={analysis.realError || ''}>mark-preview (real transform: {analysis.realError ? 'error' : 'n/a'})</span>
				{/if}
				{#if !csr && analysis.outputClient && analysis.outputClient !== analysis.output}
					<span class="legs" data-obs-legs>
						<button class:on={leg === 'ssr'} onclick={() => (leg = 'ssr')}>SSR leg</button>
						<button class:on={leg === 'client'} onclick={() => (leg = 'client')}>client leg</button>
					</span>
				{/if}
			</div>
			{#if !everWarmed}
				<div class="warming" data-obs-warming>warming the in-browser compiler (rolldown WASM)…</div>
			{/if}
			<div class="code-out" data-obs-output>
				<FormattedCode doc={shownOutput} lang="svelte" />
			</div>

			{#if analysis.compiledServer}
				<details class="pipe" data-obs-compiled>
					<summary>svelte-compiled server JS <span class="muted">· source → transform → svelte compile</span></summary>
					<div class="code-out"><FormattedCode doc={analysis.compiledServer} lang="js" /></div>
				</details>
			{/if}
			</div>

			<div class="tp" class:on={inspectorTab === 'islands'} data-tab="islands">
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
								<div class="code-out"><FormattedCode doc={m.wrapperSource} lang="svelte" /></div>
							{/if}
							{#if m.entrySource}
								<div class="mpath">{m.entryPath}</div>
								<div class="code-out"><FormattedCode doc={m.entrySource} lang="js" /></div>
							{/if}
							{#if !m.wrapperSource && !m.entrySource}
								<div class="muted mpath">no standalone module (rendered inline / binding-only)</div>
							{/if}
						</details>
					{/each}
				</div>
			{/if}
			</div>
			</div>
		</section>
	</div>
</div>

<style>
	/* Full-viewport REPL, edge to edge (Svelte-REPL style). Colours come from the docs tokens
	   (app.css) so it's light/dark theme-aware and matches the site. */
	.obs {
		font: 12px/1.5 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		color: var(--text);
		background: var(--bg);
		/* Fills the layout's .obs-page flex column (under the site nav). 100dvh fallback if used bare. */
		flex: 1;
		min-height: 0;
		height: 100%;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.obs-bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 14px;
		border-bottom: 1px solid var(--line);
		background: var(--bg-raised);
		flex: none;
	}
	.obs-brand {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex: none;
	}
	.obs-brand b {
		color: var(--accent);
		font-family: var(--font-display, inherit);
		font-size: 15px;
		font-weight: 600;
	}
	.obs-sub {
		color: var(--text-faint);
		font-size: 11px;
	}
	.obs-bar-right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.csrswitch {
		display: inline-flex;
		gap: 2px;
		margin-left: 6px;
		padding: 2px;
		border-radius: 7px;
		background: rgba(148, 163, 184, 0.1);
	}
	.csrswitch button {
		padding: 2px 9px;
		border: 0;
		border-radius: 5px;
		background: none;
		color: var(--text-dim);
		font: inherit;
		font-size: 10px;
		cursor: pointer;
	}
	.csrswitch button.on {
		background: #14b8a6;
		color: #04121a;
		font-weight: 600;
	}
	/* Reserved, right-aligned status slot — busy toggles via visibility (keeps its box) and the timing
	   has a fixed min-width, so "compiling…" appearing never reflows the header. */
	.status {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		flex: none;
	}
	.ms {
		color: var(--accent);
		font-size: 11px;
		min-width: 52px;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.busy {
		color: #fbbf24;
		visibility: hidden;
	}
	.busy.show {
		visibility: visible;
	}
	.presets {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.presets button {
		padding: 2px 8px;
		border: 1px solid rgba(148, 163, 184, 0.25);
		background: var(--bg-raised);
		color: var(--text-dim);
		font: inherit;
		font-size: 10px;
		cursor: pointer;
		border-radius: 5px;
	}
	.presets button:hover {
		color: var(--text);
		border-color: rgba(148, 163, 184, 0.5);
	}
	.share {
		padding: 3px 11px;
		border: 1px solid color-mix(in oklab, var(--accent) 40%, var(--line));
		border-radius: 6px;
		background: var(--bg);
		color: var(--accent);
		font: inherit;
		font-size: 11px;
		font-weight: 600;
		cursor: pointer;
	}
	.share:hover {
		background: color-mix(in oklab, var(--accent) 12%, transparent);
	}
	.muted {
		color: var(--text-faint);
	}
	.obs-main {
		flex: 1;
		min-height: 0;
		/* SplitPane sets display:flex + per-pane flex-grow inline; this is the desktop layout. */
	}
	.obs-editor {
		display: flex;
		flex-direction: column;
		/* CodeMirror's content has a large min-content width (long lines); the splitpane already sets
		   min-width:0 on panes, but keep it explicit so the editor never blows past its flex track. */
		min-width: 0;
		min-height: 0;
	}
	/* The draggable divider between panes. */
	.obs-gutter {
		flex: 0 0 7px;
		cursor: col-resize;
		background: var(--line);
		position: relative;
		transition: background 0.15s;
	}
	.obs-gutter::after {
		/* a wider invisible hit-area so the 7px gutter is easy to grab */
		content: '';
		position: absolute;
		inset: 0 -4px;
	}
	.obs-gutter:hover,
	.obs-gutter:active {
		background: var(--accent);
	}
	/* Mobile pane switch — hidden on desktop, both panes visible. */
	.obs-mobile-switch {
		display: none;
	}
	/* ── File tree pane (left column) ── */
	.obs-tree-pane {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		border-right: 1px solid rgba(148, 163, 184, 0.1);
	}
	.obs-tree-pane.collapsed {
		/* a thin strip with a reopen button; beats the splitpane's inline flex-grow */
		flex: 0 0 30px !important;
	}
	.tree-reopen {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 10px 0;
		border: 0;
		background: var(--bg-raised);
		color: var(--text-dim);
		cursor: pointer;
		font: inherit;
	}
	.tree-reopen:hover {
		color: var(--accent);
	}
	.tree-reopen .tr-arrow {
		font-size: 13px;
	}
	.tree-reopen .tr-label {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		writing-mode: vertical-rl;
	}
	/* ── Editor pane header (active file path + Format) ── */
	.obs-editor-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 10px 5px 12px;
		border-bottom: 1px solid rgba(148, 163, 184, 0.12);
	}
	.ehead-path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		direction: rtl; /* keep the filename (right end) visible when the path is long */
		text-align: left;
		font-family: var(--font-mono, ui-monospace, Menlo, monospace);
		font-size: 11px;
		color: var(--text-dim);
	}
	.fmt {
		align-self: center;
		padding: 3px 10px;
		border: 1px solid var(--line);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text-dim);
		font: inherit;
		font-size: 11px;
		font-weight: 600;
		cursor: pointer;
	}
	.fmt:hover {
		color: var(--text);
		border-color: var(--line-strong);
	}
	.fmt:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.cap {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 14px;
		color: var(--text-dim);
		font-weight: 600;
		border-bottom: 1px solid rgba(148, 163, 184, 0.12);
		background: rgba(148, 163, 184, 0.05);
	}
	.obs-editor :global(.cm-host) {
		flex: 1;
	}
	.obs-inspector {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}
	/* Tab bar over the inspector — turns the old 6 stacked sections into one-at-a-time views. */
	.obs-tabs {
		display: flex;
		gap: 2px;
		padding: 6px 10px 0;
		border-bottom: 1px solid var(--line);
		flex: none;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.obs-tabs::-webkit-scrollbar {
		display: none;
	}
	.obs-tabs button {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 6px 12px;
		border: 0;
		border-bottom: 2px solid transparent;
		background: none;
		color: var(--text-dim);
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
	}
	.obs-tabs button:hover {
		color: var(--text);
	}
	.obs-tabs button.on {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}
	.obs-tabs .tcount {
		padding: 0 6px;
		border-radius: 999px;
		background: color-mix(in oklab, var(--accent) 20%, transparent);
		color: var(--accent);
		font-size: 10px;
	}
	.obs-tabbody {
		flex: 1;
		min-height: 0;
		overflow: auto;
		display: flex;
		flex-direction: column;
	}
	/* One tab visible at a time. `.tp` panels are shown only when active; a hidden panel is display:none
	   so its (possibly interactive) preview / iframe doesn't run in the background. */
	.tp {
		display: none;
		flex-direction: column;
		min-height: 0;
	}
	.tp.on {
		display: flex;
	}
	/* Preview tab fills the body so the iframe/preview gets real height. */
	.tp[data-tab='preview'].on {
		flex: 1;
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
		color: var(--text-dim);
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
		color: var(--accent);
		font-size: 9px;
		vertical-align: 1px;
	}
	/* Code surface for every readonly CodeMirror output (transformed host, compiled JS, modules, HTML). */
	.code-out {
		margin: 8px 14px 12px;
		padding: 4px 6px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--bg-sunken);
		overflow: auto;
	}
	.mods .code-out {
		margin: 6px 0 0;
	}
	.real {
		margin-left: 8px;
		padding: 1px 8px;
		border-radius: 999px;
		background: rgba(20, 184, 166, 0.16);
		color: var(--accent);
		font-weight: 600;
		font-size: 10px;
	}
	.real.csr-true {
		background: rgba(148, 163, 184, 0.18);
		color: var(--text-dim);
	}
	.fallback {
		margin-left: 8px;
		color: var(--text-faint);
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
		background: var(--bg-raised);
		color: var(--text-dim);
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
		flex: 1;
		min-height: 220px;
		margin: 10px 14px 14px;
		padding: 14px;
		border: 1px dashed var(--line-strong);
		border-radius: 8px;
		overflow: auto;
		/* The live/x-ray demos use --obs-* tokens (defined inside the iframe for islands mode); map them to
		   the SITE tokens here so the canvas is neutral + theme-aware (not a bespoke navy) and matches docs. */
		--obs-bg: var(--bg-raised);
		--obs-panel: var(--bg-sunken);
		--obs-text: var(--text);
		--obs-muted: var(--text-dim);
		--obs-border: var(--line);
		--obs-accent: var(--accent);
		background: var(--obs-bg);
		color: var(--obs-text);
	}
	.preview.frame {
		flex: 1;
		min-height: 240px;
		padding: 0;
		border-style: solid;
		border-color: var(--line);
		width: auto;
		height: auto;
	}

	/* ── Mobile: one pane at a time, toggled by the Editor/Result switch (Svelte-REPL style) ── */
	@media (max-width: 820px) {
		.obs-bar {
			flex-wrap: wrap;
			gap: 6px 8px;
			padding: 8px 10px;
		}
		.obs-sub {
			display: none;
		}
		.presets {
			order: 3;
			width: 100%;
			overflow-x: auto;
			scrollbar-width: none;
			flex-wrap: nowrap;
			padding-bottom: 2px;
		}
		.presets::-webkit-scrollbar {
			display: none;
		}
		.obs-bar-right {
			gap: 6px;
		}
		.obs-mobile-switch {
			display: flex;
			gap: 4px;
			padding: 6px 10px;
			border-bottom: 1px solid var(--line);
			background: var(--bg-raised);
			flex: none;
		}
		.obs-mobile-switch button {
			flex: 1;
			padding: 8px;
			border: 1px solid var(--line);
			border-radius: 7px;
			background: var(--bg);
			color: var(--text-dim);
			font: inherit;
			font-size: 12px;
			font-weight: 600;
			cursor: pointer;
		}
		.obs-mobile-switch button.on {
			background: var(--accent);
			color: var(--text-on-invert, #04121a);
			border-color: var(--accent);
		}
		/* Mobile ignores the splitpane: override its inline display:flex back to a single-pane stack, and
		   hide the gutter. The panes' inline flex-grow is inert under display:block. !important beats the
		   inline styles the splitpane sets. */
		.obs-main {
			display: block !important;
		}
		.obs-gutter {
			display: none !important;
		}
		/* The tree pane's collapse strip is a desktop affordance — full tree on mobile. */
		.obs-tree-pane.collapsed {
			flex: none !important;
		}
		/* Only the selected pane is shown; the tree pane takes the full width on mobile. */
		.obs-main[data-pane='files'] .obs-editor,
		.obs-main[data-pane='files'] .obs-inspector,
		.obs-main[data-pane='editor'] .obs-tree-pane,
		.obs-main[data-pane='editor'] .obs-inspector,
		.obs-main[data-pane='result'] .obs-tree-pane,
		.obs-main[data-pane='result'] .obs-editor {
			display: none !important;
		}
		.obs-tree-pane {
			border-right: 0;
		}
	}
	.preview :global(.og-stub) {
		display: inline-block;
		padding: 0 6px;
		border-radius: 4px;
		background: rgba(20, 184, 166, 0.15);
		color: #0d9488;
		font: 11px ui-monospace, Menlo, monospace;
	}
	.preview :global(.obs-fallback) {
		display: inline-block;
		padding: 1px 8px;
		border-radius: 4px;
		background: rgba(139, 92, 246, 0.15);
		color: #8b5cf6;
		font-size: 11px;
		animation: obs-pulse 1s ease-in-out infinite;
	}
	@keyframes obs-pulse {
		0%,
		100% {
			opacity: 0.5;
		}
		50% {
			opacity: 1;
		}
	}
	/* The x-ray boundary lens now lives in the isolated iframe (observatory-frame/+page.svelte), overlaid
	   on the REAL islands — see there. The in-page preview only ever renders `live` mode now. */
	.lens-legend {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 8px 14px 2px;
	}
	.lens-legend .lk {
		padding: 1px 8px;
		border-radius: 999px;
		font-size: 10px;
		font-weight: 600;
	}
	.lens-legend .lk.island {
		background: rgba(20, 184, 166, 0.16);
		color: var(--accent);
	}
	.lens-legend .lk.hole {
		background: rgba(139, 92, 246, 0.18);
		color: #c4b5fd;
	}
	.lens-legend .lk.live {
		background: rgba(139, 92, 246, 0.18);
		color: #c4b5fd;
	}
	.lens-legend .lk.shell {
		background: rgba(148, 163, 184, 0.14);
		color: var(--text-dim);
	}
	.lens-legend .replay {
		margin-left: auto;
		padding: 1px 9px;
		border: 1px solid rgba(20, 184, 166, 0.4);
		border-radius: 999px;
		background: var(--bg-raised);
		color: var(--accent);
		font: inherit;
		font-size: 10px;
		cursor: pointer;
	}
	.lens-legend .replay:hover {
		background: rgba(20, 184, 166, 0.14);
	}
	.wakehint {
		padding: 0 14px 6px;
		font-size: 10px;
	}
	.wakehint b {
		color: var(--text-dim);
	}
	/* Server/live-region notice in LIVE mode — a warm tint, since it's telling you why nothing moves. */
	.srvhint {
		margin: 2px 14px 8px;
		padding: 7px 10px;
		font-size: 11px;
		line-height: 1.5;
		color: var(--text-dim);
		background: color-mix(in oklab, #f59e0b 9%, transparent);
		border: 1px solid color-mix(in oklab, #f59e0b 26%, transparent);
		border-radius: 8px;
	}
	.srvhint b {
		color: var(--text);
	}
	.tolink {
		border: 0;
		background: none;
		padding: 0;
		font: inherit;
		font-weight: 600;
		color: var(--accent);
		cursor: pointer;
		white-space: nowrap;
	}
	.tolink:hover {
		text-decoration: underline;
	}
	.navinfo {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin: 2px 14px 8px;
		font-size: 11px;
	}
	.navinfo .ni-cap {
		color: var(--text-dim);
		font-weight: 600;
	}
	.navinfo .ni {
		padding: 1px 8px;
		border-radius: 999px;
		font-weight: 600;
	}
	.navinfo .kept {
		background: rgba(20, 184, 166, 0.16);
		color: var(--accent);
	}
	.navinfo .mounted {
		background: rgba(139, 92, 246, 0.18);
		color: #c4b5fd;
	}
	.navinfo .removed {
		background: rgba(148, 163, 184, 0.14);
		color: var(--text-dim);
		text-decoration: line-through;
	}
	.rtev {
		margin: 4px 14px 8px;
		border: 1px solid rgba(148, 163, 184, 0.15);
		border-radius: 6px;
		overflow: hidden;
	}
	.rtev-cap {
		padding: 5px 10px;
		background: rgba(148, 163, 184, 0.05);
		color: var(--text-dim);
		font-weight: 600;
		font-size: 11px;
	}
	.rtev-log {
		max-height: 140px;
		overflow: auto;
		padding: 4px 0;
	}
	.rtev-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 1px 12px;
		font-size: 11px;
	}
	.rtev-island {
		width: 110px;
		flex: none;
		color: var(--accent);
		text-align: right;
	}
	.rtev-icon {
		width: 12px;
		flex: none;
		text-align: center;
	}
	.rtev-row.ev-dim {
		color: var(--text-faint);
	}
	.rtev-row.ev-wake .rtev-icon,
	.rtev-row.ev-wake .rtev-text {
		color: #fbbf24;
	}
	.rtev-row.ev-done .rtev-icon,
	.rtev-row.ev-done .rtev-text {
		color: var(--accent);
		font-weight: 600;
	}
	.rtev-row.ev-fail .rtev-icon,
	.rtev-row.ev-fail .rtev-text {
		color: #fca5a5;
	}
	.stubnote {
		padding: 1px 8px;
		border-radius: 999px;
		background: rgba(148, 163, 184, 0.12);
		color: var(--text-dim);
		font-size: 10px;
	}
	.saved {
		margin-left: auto;
		padding: 1px 9px;
		border-radius: 999px;
		background: rgba(20, 184, 166, 0.18);
		color: var(--accent);
		font-weight: 700;
		font-size: 11px;
	}
	.ledger {
		padding: 10px 14px 6px;
	}
	.bars {
		display: flex;
		flex-direction: column;
		gap: 7px;
		margin-bottom: 10px;
	}
	.barrow {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.blabel {
		width: 62px;
		flex: none;
		color: var(--text-dim);
		text-align: right;
	}
	.btrack {
		flex: 1;
		height: 14px;
		border-radius: 4px;
		background: rgba(148, 163, 184, 0.1);
		overflow: hidden;
	}
	.bfill {
		height: 100%;
		border-radius: 4px;
		transition: width 0.35s cubic-bezier(0.4, 0, 0.2, 1);
	}
	.bfill.og {
		background: linear-gradient(90deg, #0d9488, var(--accent));
	}
	.bfill.kit {
		background: rgba(148, 163, 184, 0.35);
	}
	.bnum {
		width: 130px;
		flex: none;
	}
	.bnum.og {
		color: var(--accent);
		font-weight: 700;
	}
	.bnum.kit {
		color: var(--text-dim);
	}
	.ltable {
		width: 100%;
		border-collapse: collapse;
	}
	.ltable td {
		padding: 3px 0;
		vertical-align: top;
	}
	.ltable tr + tr td {
		border-top: 1px solid rgba(148, 163, 184, 0.07);
	}
	.lname {
		color: var(--text-faint);
		width: 130px;
	}
	.ltable tr.ships .lname {
		color: var(--accent);
	}
	.lwhy {
		font-size: 11px;
	}
	.lbytes {
		text-align: right;
		white-space: nowrap;
		color: var(--text-faint);
	}
	.ltable tr.ships .lbytes {
		color: var(--text-dim);
	}
	.lraw {
		font-size: 10px;
	}
	.ltable tr.ships .lraw {
		display: none;
	}
	.lfoot {
		margin-top: 8px;
		font-size: 10px;
		line-height: 1.5;
	}
	.wire {
		padding: 6px 14px 4px;
	}
	.wrow {
		padding: 6px 0;
	}
	.wrow + .wrow {
		border-top: 1px solid rgba(148, 163, 184, 0.07);
	}
	.wtop {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 0 14px 2px;
	}
	.wname {
		flex: 1;
		color: var(--accent);
	}
	.wpay {
		flex: 1;
		color: var(--text-dim);
		word-break: break-word;
		background: rgba(148, 163, 184, 0.08);
		padding: 1px 7px;
		border-radius: 4px;
		font-size: 11px;
	}
	.wbytes {
		flex: none;
		font-size: 10px;
	}
	.wempty {
		flex: 1;
		font-size: 11px;
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
		color: var(--text-dim);
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
		color: var(--accent);
		font-size: 10px;
	}
	.mpath {
		padding: 6px 10px 2px;
		color: var(--text-dim);
		font-size: 10px;
	}
	.msrc {
		margin: 0;
		padding: 6px 10px 10px;
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--text-dim);
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
