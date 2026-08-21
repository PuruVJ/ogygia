<script>
	import { mount, unmount } from 'svelte';
	// The devtools event bus — in "islands" mode the page's REAL runtime emits hydration events for our
	// injected regions; we tap the bus to show the true lifecycle story (Rung-0 layer → an instrument).
	import { add_sink } from 'ogygia/devtools';
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
		'Menu.svelte': `<scr${''}ipt>let open = $state(false);</scr${''}ipt>
<button onclick={() => (open = !open)}>Menu {open ? '▲' : '▼'}</button>
{#if open}<ul><li>Profile</li><li>Settings</li><li>Log out</li></ul>{/if}`,
		'Chart.svelte': `<scr${''}ipt>let { data = [] } = $props();</scr${''}ipt>
<div class="chart">{#each data as v}<span style="height: {v * 6}px"></span>{/each}</div>
<style>.chart { display: flex; gap: 3px; align-items: flex-end; height: 60px; }
.chart span { width: 12px; background: #14b8a6; border-radius: 2px; }</style>`
	};

	// Presets are file MAPS (Rung 6 multi-file). Most are single-file (their imports stub on render).
	const PRESETS = {
		'demo app': FILES_DEMO,
		'wake demo': FILES_WAKE,
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

	// Byte ledger helpers — the ogygia thesis, weighed live.
	const fmt_bytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

	// Pretty-print a real runtime event (islands mode) into a short human line.
	function fmt_event(e) {
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
	let previewMode = $state('live'); // 'live' (interactive mount) | 'xray' (boundary lens) | 'islands'
	let wakeNonce = $state(0); // bump to replay the x-ray wake sequence
	let xrayCleanup = /** @type {null | (() => void)} */ (null);
	// REAL runtime events for the injected preview islands (islands mode), tapped off the devtools bus.
	let runtimeEvents = $state(/** @type {Array<{name: string, label: string, t: number, ms?: number, when?: string}>} */ ([]));
	$effect(() => {
		import('svelte/internal/client')
			.then((m) => (svelteClient = m))
			.catch(() => {});
	});

	// WAKE VISUALIZER (x-ray): arm each island's REAL schedule with real browser primitives — `load`
	// fires now, `idle` on requestIdleCallback, `visible` on a real IntersectionObserver (scroll the
	// preview), `interaction` on the first pointer/focus inside, a media query on matchMedia; lakes +
	// held-raw never wake (frozen). Each island lights from cold→hot when it wakes, stamped with +Xms.
	function arm_wakes(el) {
		const t0 = performance.now();
		const cleanups = [];
		const wake = (node, reason) => {
			if (node.getAttribute('data-woke') === 'true') return;
			node.setAttribute('data-woke', 'true');
			node.setAttribute('data-woke-ms', String(Math.round(performance.now() - t0)));
			node.setAttribute('data-woke-reason', reason);
		};
		for (const node of el.querySelectorAll('[data-obs-island]')) {
			const w = node.getAttribute('data-wake') || '';
			const kind = node.getAttribute('data-kind') || '';
			// lakes + held-raw + server holes never ship JS to wake — mark frozen and leave them.
			if (!(kind === 'island' || kind === 'preset')) {
				node.setAttribute('data-woke', 'frozen');
				continue;
			}
			node.setAttribute('data-woke', 'false');
			if (w === 'load' || w === '') {
				// load = as soon as the runtime connects; fire next frame so the glow animates in.
				const id = requestAnimationFrame(() => wake(node, 'load'));
				cleanups.push(() => cancelAnimationFrame(id));
			} else if (w === 'idle') {
				if ('requestIdleCallback' in window) {
					const id = requestIdleCallback(() => wake(node, 'idle'), { timeout: 1500 });
					cleanups.push(() => cancelIdleCallback(id));
				} else {
					const id = setTimeout(() => wake(node, 'idle'), 500);
					cleanups.push(() => clearTimeout(id));
				}
			} else if (w === 'visible') {
				const io = new IntersectionObserver(
					(entries) => {
						for (const e of entries)
							if (e.isIntersecting) {
								wake(node, 'visible');
								io.disconnect();
							}
					},
					{ root: el }
				);
				io.observe(node);
				cleanups.push(() => io.disconnect());
			} else if (w === 'interaction') {
				const onInt = () => wake(node, 'interaction');
				node.addEventListener('pointerdown', onInt, { once: true });
				node.addEventListener('focusin', onInt, { once: true });
				cleanups.push(() => {
					node.removeEventListener('pointerdown', onInt);
					node.removeEventListener('focusin', onInt);
				});
			} else {
				// a media query string
				try {
					const mql = matchMedia(w);
					const onC = () => mql.matches && wake(node, 'media');
					onC();
					mql.addEventListener('change', onC);
					cleanups.push(() => mql.removeEventListener('change', onC));
				} catch {
					/* invalid query — leave asleep */
				}
			}
		}
		return () => cleanups.forEach((c) => c());
	}

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
		const mode = previewMode;
		wakeNonce; // dep: bumping it replays the x-ray wake sequence
		if (!el) return;
		if (xrayCleanup) {
			xrayCleanup();
			xrayCleanup = null;
		}
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
		// X-RAY (boundary lens): show the marked SSR HTML, tinted by the .xray class — no live mount.
		// Then arm the wake visualizer so each island lights up on its real schedule.
		if (mode === 'xray') {
			fallback();
			xrayCleanup = arm_wakes(el);
			return;
		}
		// ISLANDS (real runtime): inject the app's SSR with genuine <ogygia-region> shells so the PAGE's
		// own ogygia runtime hydrates them lazily. Each region's __ISLAND__ placeholder entry is rewritten
		// to a blob of the client-linked component (stashed on a global the blob re-exports). This is the
		// actual framework running in the preview — real schedules, real hydration — not a mount() stand-in.
		if (mode === 'islands') {
			const rd = analysis.realDom;
			if (!rd?.ok || !rd.html || !sc || !client || client.error) {
				fallback();
				return;
			}
			try {
				runtimeEvents = [];
				const fpNames = {};
				// Subscribe to the devtools bus BEFORE injecting, so we catch the full lifecycle. Only our
				// own injected regions (data-og-fp="obsfp_…") are relayed; the page's other islands are not.
				// The bus emits SYNCHRONOUSLY during hydration (which we trigger from inside this effect);
				// writing $state synchronously there would form a reactive cycle, so batch + flush on a frame.
				let pending = [];
				let flushing = false;
				const flush = () => {
					flushing = false;
					if (pending.length) {
						runtimeEvents = [...runtimeEvents, ...pending].slice(-60);
						pending = [];
					}
				};
				const unsubscribe = add_sink((ev) => {
					if (ev?.domain !== 'runtime' || !ev.fp || !String(ev.fp).startsWith('obsfp_')) return;
					pending.push({ name: ev.name, label: fpNames[ev.fp] || String(ev.fp), t: ev.t, ms: ev.ms, when: ev.when });
					if (!flushing) {
						flushing = true;
						requestAnimationFrame(flush);
					}
				});
				const store = (globalThis.__OBS_ISLANDS__ ||= {});
				const blobs = [];
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
						const ex = {};
						cache.set(name, ex);
						Object.assign(ex, eval_client(client.modules[name], require));
						return ex;
					}
					return { default: () => {} };
				};
				// build the DOM OFFLINE so we can set the real blob entry BEFORE the element connects
				// (custom-element upgrade + the runtime's connectedCallback fire on insertion).
				const tpl = document.createElement('div');
				tpl.innerHTML = rd.html;
				for (const region of tpl.querySelectorAll('ogygia-region[entry^="__ISLAND__:"]')) {
					const file = region.getAttribute('entry').slice('__ISLAND__:'.length);
					if (client.modules[file] == null) continue;
					fpNames[region.getAttribute('data-og-fp')] = region.getAttribute('data-name') || file;
					const Comp = eval_client(client.modules[file], require).default;
					const key = 'k' + Math.random().toString(36).slice(2);
					store[key] = Comp;
					const blob = URL.createObjectURL(
						new Blob([`export default globalThis.__OBS_ISLANDS__[${JSON.stringify(key)}]`], { type: 'text/javascript' })
					);
					blobs.push({ blob, key });
					region.setAttribute('entry', blob);
				}
				while (tpl.firstChild) el.appendChild(tpl.firstChild); // → runtime upgrades + hydrates
				// cleanup on the next run: removing the nodes (el.innerHTML='') fires the runtime's
				// disconnectedCallback (unmount); we revoke blobs, release the stashed components, and
				// stop listening on the bus.
				xrayCleanup = () => {
					unsubscribe();
					for (const { blob, key } of blobs) {
						URL.revokeObjectURL(blob);
						delete store[key];
					}
				};
				return;
			} catch (e) {
				console.error('[observatory] islands mode failed:', e);
				fallback();
				return;
			}
		}
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
					rendered
					<span class="muted">· {previewMode === 'live' ? 'live, interactive — mounted in your browser' : previewMode === 'xray' ? 'x-ray — every marked region is an island' : 'islands — the real ogygia runtime hydrates each region'}</span>
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
						<span class="lk lake">lake · frozen</span>
						<span class="lk hole">server hole</span>
						<span class="lk raw">held raw</span>
						<span class="lk shell">the rest · free server HTML</span>
						<button class="replay" data-obs-replay title="re-arm the wake schedules" onclick={() => wakeNonce++}>⟳ replay wakes</button>
					</div>
					<div class="wakehint muted">islands start cold. <b>load</b> wakes now · <b>idle</b> soon · <b>visible</b> on scroll · <b>interaction</b> on click · lakes stay frozen.</div>
				{/if}
				{#if previewMode === 'islands'}
					<div class="wakehint muted" data-obs-islands-hint>
						the page's <b>real ogygia runtime</b> hydrated these — genuine <b>&lt;ogygia-region&gt;</b> shells,
						blob-linked island chunks, lazy per schedule. Try the <b>wake demo</b> preset: click Menu, scroll to Chart.
					</div>
				{/if}
				{#if previewMode === 'islands' && runtimeEvents.length}
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
				<!-- Interactive mount (live) OR marked SSR HTML tinted by the lens (x-ray). -->
				<div class="preview" class:xray={previewMode === 'xray'} bind:this={previewEl} data-obs-preview></div>
				{#if analysis.rendered.ok}
					<details class="pipe">
						<summary>▸ rendered HTML source (SSR)</summary>
						<pre class="msrc" data-obs-html>{analysis.rendered.html}</pre>
					</details>
				{:else if !analysis.client || analysis.client.error}
					<div class="err" data-obs-render-err>could not render: {analysis.rendered.error}</div>
				{/if}
			{/if}

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

			{#if analysis.rendered?.wire && analysis.rendered.wire.length}
				<div class="cap">wire <span class="muted">· the props that cross to each island, by value (devalue)</span></div>
				<div class="wire" data-obs-wire>
					{#each analysis.rendered.wire as w, i (w.name + i)}
						<div class="wrow">
							<span class="wname mono">{w.name}</span>
							{#if w.payload === '{}' || w.payload === '[{},[]]' || w.payload === '[{}]'}
								<span class="muted wempty">no props cross — nothing to serialize</span>
							{:else}
								<code class="wpay">{w.payload}</code>
								<span class="wbytes muted">{w.bytes} B</span>
							{/if}
						</div>
					{/each}
				</div>
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
	/* ── BOUNDARY LENS (x-ray): dim the dead shell, light up every marked island ── */
	.preview.xray {
		background: #f1f5f9;
		color: #94a3b8;
		position: relative;
		max-height: 360px;
	}
	.preview.xray :global(ogygia-obs-island) {
		display: block;
		position: relative;
		margin: 22px 0 10px;
		padding: 8px 10px;
		border-radius: 7px;
		color: #0f172a;
		outline: 2px solid var(--lens, #14b8a6);
		background: color-mix(in srgb, var(--lens, #14b8a6) 8%, transparent);
	}
	.preview.xray :global(ogygia-obs-island::before) {
		content: attr(data-name) ' · ' attr(data-kind);
		position: absolute;
		top: -18px;
		left: -2px;
		padding: 1px 7px;
		border-radius: 5px 5px 0 0;
		background: var(--lens, #14b8a6);
		color: #04121a;
		font: 700 10px/1.5 ui-monospace, Menlo, monospace;
		white-space: nowrap;
	}
	.preview.xray :global(ogygia-obs-island[data-ships='true']::after) {
		position: absolute;
		top: -18px;
		right: -2px;
		padding: 1px 7px;
		border-radius: 5px 5px 0 0;
		font: 10px/1.5 ui-monospace, Menlo, monospace;
	}
	/* cold: the island hasn't woken yet — dashed, dimmed, waiting for its schedule */
	.preview.xray :global(ogygia-obs-island[data-ships='true'][data-woke='false']) {
		outline-style: dashed;
		outline-color: color-mix(in srgb, var(--lens, #14b8a6) 55%, transparent);
		background: rgba(148, 163, 184, 0.06);
	}
	.preview.xray :global(ogygia-obs-island[data-ships='true'][data-woke='false'] > *) {
		opacity: 0.45;
		filter: grayscale(0.5);
	}
	.preview.xray :global(ogygia-obs-island[data-ships='true'][data-woke='false']::after) {
		content: '💤 asleep · wakes on ' attr(data-wake);
		background: rgba(100, 116, 139, 0.25);
		color: #94a3b8;
	}
	/* hot: it woke — solid, lit, stamped with when + bytes */
	.preview.xray :global(ogygia-obs-island[data-ships='true'][data-woke='true']) {
		outline-style: solid;
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--lens, #14b8a6) 18%, transparent);
		transition: box-shadow 0.25s ease;
	}
	.preview.xray :global(ogygia-obs-island[data-ships='true'][data-woke='true']::after) {
		content: '⚡ woke +' attr(data-woke-ms) 'ms · ' attr(data-bytes) ' B JS';
		background: color-mix(in srgb, var(--lens, #14b8a6) 25%, #0b1220);
		color: var(--lens, #14b8a6);
	}
	.preview.xray :global(ogygia-obs-island[data-kind='island']) {
		--lens: #14b8a6;
	}
	.preview.xray :global(ogygia-obs-island[data-kind='preset']) {
		--lens: #14b8a6;
	}
	.preview.xray :global(ogygia-obs-island[data-kind='lake']) {
		--lens: #f59e0b;
	}
	.preview.xray :global(ogygia-obs-island[data-kind='held (raw)']) {
		--lens: #fb923c;
	}
	.preview.xray :global(ogygia-obs-island[data-kind='server hole']),
	.preview.xray :global(ogygia-obs-island[data-kind='live']) {
		--lens: #8b5cf6;
	}
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
		color: #5eead4;
	}
	.lens-legend .lk.lake {
		background: rgba(245, 158, 11, 0.16);
		color: #fbbf24;
	}
	.lens-legend .lk.hole {
		background: rgba(139, 92, 246, 0.18);
		color: #c4b5fd;
	}
	.lens-legend .lk.raw {
		background: rgba(251, 146, 60, 0.16);
		color: #fdba74;
	}
	.lens-legend .lk.shell {
		background: rgba(148, 163, 184, 0.14);
		color: #94a3b8;
	}
	.lens-legend .replay {
		margin-left: auto;
		padding: 1px 9px;
		border: 1px solid rgba(20, 184, 166, 0.4);
		border-radius: 999px;
		background: #0d1526;
		color: #5eead4;
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
		color: #94a3b8;
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
		color: #94a3b8;
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
		color: #5eead4;
		text-align: right;
	}
	.rtev-icon {
		width: 12px;
		flex: none;
		text-align: center;
	}
	.rtev-row.ev-dim {
		color: #64748b;
	}
	.rtev-row.ev-wake .rtev-icon,
	.rtev-row.ev-wake .rtev-text {
		color: #fbbf24;
	}
	.rtev-row.ev-done .rtev-icon,
	.rtev-row.ev-done .rtev-text {
		color: #5eead4;
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
		color: #94a3b8;
		font-size: 10px;
	}
	.saved {
		margin-left: auto;
		padding: 1px 9px;
		border-radius: 999px;
		background: rgba(20, 184, 166, 0.18);
		color: #5eead4;
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
		color: #94a3b8;
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
		background: linear-gradient(90deg, #0d9488, #5eead4);
	}
	.bfill.kit {
		background: rgba(148, 163, 184, 0.35);
	}
	.bnum {
		width: 130px;
		flex: none;
	}
	.bnum.og {
		color: #5eead4;
		font-weight: 700;
	}
	.bnum.kit {
		color: #94a3b8;
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
		color: #64748b;
		width: 130px;
	}
	.ltable tr.ships .lname {
		color: #5eead4;
	}
	.lwhy {
		font-size: 11px;
	}
	.lbytes {
		text-align: right;
		white-space: nowrap;
		color: #64748b;
	}
	.ltable tr.ships .lbytes {
		color: #cbd5e1;
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
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 3px 0;
	}
	.wrow + .wrow {
		border-top: 1px solid rgba(148, 163, 184, 0.07);
	}
	.wname {
		width: 120px;
		flex: none;
		color: #5eead4;
	}
	.wpay {
		flex: 1;
		color: #cbd5e1;
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
