// MUST be first: shims `process` for rolldown-browser's tsconfig helper (runs before it loads).
import './rd-process-shim';
import { parse, compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import * as svelteInternalServer from 'svelte/internal/server';
import { stringify as devalue_stringify } from 'devalue';
import path from 'path-browserify';
// The REAL ogygia host transform + id helpers + the parser DI seam, from the minimal browser entry.
import {
	transformHost,
	islandVirtualId,
	wrapperVirtualId,
	CLIENT_BINDING_STUB,
	set_parser
} from 'ogygia/internal/compiler-browser';

export interface Island {
	local: string;
	component: string;
	attrs: Record<string, unknown>;
	strategy: { kind: string; color: string; detail: string };
	id: string;
	/** True when `id` is the REAL md5 region id from transformHost (vs the FNV placeholder). */
	real?: boolean;
}

export interface Analysis {
	ok: boolean;
	error?: string;
	islands: Island[];
	/** The transformed host (SSR leg) — from the REAL transform when it ran, else the svelte rewrite. */
	output: string;
	/** The transformed host on the CLIENT leg (ssr=false) — csr=false ships stubs, not the wrapper. */
	outputClient?: string;
	/** The transformed host, COMPILED by svelte to server JS — the last step of the pipeline. */
	compiledServer?: string;
	compiledError?: string;
	/** Whether the output came from the real ogygia transformHost (vs the mark-only fallback). */
	real: boolean;
	/** Real island count from transformHost (md5 iids), or null. */
	realIslands: number | null;
	/** The REAL generated virtual modules per island (the wrapper + entry the driver serves). */
	modules?: Array<{
		id: string;
		component: string;
		kind: string;
		wrapperPath?: string;
		wrapperSource?: string;
		entryPath?: string;
		entrySource?: string;
	}>;
	realError?: string;
	/** Proof the SAME oxc parser (rolldown-browser WASM) the full transform uses runs in-browser. */
	oxc?: { engine: string; ok: boolean; imports: number; error?: string };
	/** Wall-clock ms for the transform + svelte compile (the whole pipeline). */
	ms?: number;
	/** EXECUTION: the component actually rendered to SSR HTML in the browser (imports not provided
	 *  render as labelled stubs). This is the compile→link→render loop running client-side. */
	rendered?: {
		ok: boolean;
		html?: string;
		error?: string;
		stubs?: string[];
		/** WIRE INSPECTOR (Rung 5.2): the real props each island receives, devalue-encoded — exactly
		 *  what crosses the boundary by value (children/functions never cross). Captured at render. */
		wire?: Array<{ name: string; kind: string; payload: string; bytes: number }>;
	};
	/** CLIENT bundle for the INTERACTIVE preview: every file compiled to client JS + the entry, so the
	 *  MAIN thread can link + `mount()` the app (the counter actually works). */
	client?: { entry: string; modules: Record<string, string>; error?: string };
	/** REAL ISLANDS (crown jewel): the app SSR with genuine `<ogygia-region>` shells + devalue prop
	 *  sidecars, wrapped in `<ogygia-slot>` so the page's OWN ogygia runtime hydrates them lazily (the
	 *  entry is a `__ISLAND__:<file>` placeholder the main thread rewrites to a blob of the linked
	 *  client component). This is the actual framework running in the preview, not a mount() stand-in. */
	realDom?: {
		ok: boolean;
		html?: string;
		error?: string;
		islands?: string[];
		/** Server islands (`render: 'deferred'`): the rendered HTML per endpoint id, which the main
		 *  thread serves through a fetch intercept so the runtime fetches it lazily, on schedule. */
		deferred?: Record<string, string>;
		/** Live regions (`render: 'live'`): the file to re-render each tick, keyed by fingerprint — the
		 *  main thread ticks them into a `<ogygia-region live>` via applyLive() (morph in place). */
		live?: Array<{ fp: string; file: string; name: string }>;
	};
	/** BYTE LEDGER (Rung 5.3): the ogygia thesis, weighed live — on a csr=false page ogygia ships only
	 *  the waking islands' JS; plain Kit (csr=true) ships every component. Same compiler, honest bytes. */
	ledger?: {
		/** Per-component compiled client JS bytes, and whether it ships under ogygia (csr=false). */
		files: Array<{ name: string; bytes: number; ships: boolean; why: string }>;
		/** Sum of the island JS ogygia actually ships (the components that wake). */
		ogygiaBytes: number;
		/** Sum of EVERY component's JS — what csr=true (plain Kit) ships to hydrate the whole tree. */
		kitBytes: number;
		/** How many components ship under ogygia vs under kit. */
		ogygiaCount: number;
		kitCount: number;
	};
}

/** Illustrative region id (only used for the svelte-fallback map; the real transform uses md5). */
function fallback_id(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

/** Resolve the two dials (+ region) to a strategy label + detail, exactly as the transform does. */
function resolve_strategy(attrs: Record<string, unknown>) {
	const render = attrs.render;
	const wake = attrs.wake as string | undefined;
	if (render === 'live')
		return { kind: 'live', color: '#8b5cf6', detail: 'baked HTML, revalidates in the background' };
	if (render === 'deferred')
		return { kind: 'server hole', color: '#8b5cf6', detail: `signed endpoint; HTML fetched on '${wake || 'load'}'` };
	if (attrs.region === 'raw')
		return { kind: 'held (raw)', color: '#f59e0b', detail: 'server-picked HTML, zero JS' };
	if (wake === 'none')
		return { kind: 'lake', color: '#f59e0b', detail: 'frozen SSR DOM inside an island, no client module' };
	if (attrs.preset)
		return { kind: 'preset', color: '#14b8a6', detail: `bundle '${attrs.preset}' from ogygia({ regions.presets })` };
	return { kind: 'island', color: '#14b8a6', detail: `hydrates on '${wake || 'load'}'` };
}

const MARK_KEYS = new Set(['wake', 'render', 'preset', 'region', 'margin']);

// ── rolldown-browser oxc: load + WARM the WASM once, then parseSync is sync (what the transform needs).
type OxcMod = {
	parse: (id: string, code: string) => Promise<unknown>;
	parseSync: (id: string, code: string) => unknown;
};
let oxc_mod: OxcMod | null = null;
let oxc_warmed = false;
let parser_installed = false;
async function ensure_oxc(): Promise<OxcMod> {
	if (!oxc_mod) oxc_mod = (await import('@rolldown/browser/utils')) as OxcMod;
	if (!oxc_warmed) {
		await oxc_mod.parse('warmup.ts', 'const _ = 1;');
		oxc_warmed = true;
	}
	if (!parser_installed) {
		// Inject the SYNC parser into ogygia's parse seam — now the real transform parses in-browser.
		set_parser((id: string, code: string) => oxc_mod!.parseSync(id, code) as never);
		parser_installed = true;
	}
	return oxc_mod;
}

/** The browser HostCtx — mirrors what the driver builds, with fs/path shimmed. */
function build_ctx(ssr: boolean) {
	return {
		root: '/repl',
		libDir: '/repl/src/lib',
		readFile: () => null,
		pathModule: path as never,
		dev: true,
		virtualPathFor: (_hostId: string, iid: string) => islandVirtualId(iid),
		wrapperPathFor: (_hostId: string, iid: string) => wrapperVirtualId(iid),
		devUrlFor: (virtualPath: string) => '/@id/' + virtualPath,
		visibleMargin: undefined,
		presets: {},
		importKeys: undefined,
		idSalt: '',
		linkVirtualIsland: true,
		clientBindingStub: CLIENT_BINDING_STUB,
		routeCsr: false,
		ssr
	};
}

/** Svelte-based mark map (fast, always-on) for the friendly strategy table + a fallback host rewrite. */
function analyze_marks(source: string): { islands: Island[]; output: string; ok: boolean; error?: string } {
	let ast: ReturnType<typeof parse>;
	try {
		ast = parse(source, { modern: true });
	} catch (e) {
		return { islands: [], output: source, ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	const bodies: Array<Record<string, unknown>> = [];
	const inst = (ast as { instance?: { content?: { body?: unknown[] } } }).instance;
	const mod = (ast as { module?: { content?: { body?: unknown[] } } }).module;
	if (inst?.content?.body) bodies.push(...(inst.content.body as Array<Record<string, unknown>>));
	if (mod?.content?.body) bodies.push(...(mod.content.body as Array<Record<string, unknown>>));

	const islands: Island[] = [];
	const edits: Array<{ start: number; end: number; text: string }> = [];
	for (const node of bodies) {
		if (node.type !== 'ImportDeclaration') continue;
		const attrs: Record<string, unknown> = {};
		for (const a of (node.attributes as Array<Record<string, never>>) || []) {
			const key = (a.key as { name?: string; value?: string })?.name ?? (a.key as { value?: string })?.value;
			if (key) attrs[key] = (a.value as { value?: unknown })?.value;
		}
		if (!Object.keys(attrs).some((k) => MARK_KEYS.has(k))) continue;
		const local = (node.specifiers as Array<{ local?: { name?: string } }>)?.[0]?.local?.name ?? '?';
		const component = (node.source as { value: string }).value;
		const strategy = resolve_strategy(attrs);
		const id = fallback_id(component + ' ' + JSON.stringify(attrs));
		islands.push({ local, component, attrs, strategy, id });
		edits.push({
			start: node.start as number,
			end: node.end as number,
			text: `import ${local} from 'virtual:ogygia/wrapper/${id}'; // ${strategy.kind}`
		});
	}
	let output = source;
	for (const e of edits.sort((a, b) => b.start - a.start)) {
		output = output.slice(0, e.start) + e.text + output.slice(e.end);
	}
	return { islands, output, ok: true };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ── EXECUTION: a tiny in-worker module linker (compile → eval → svelte/server render) ──
// Rewrites svelte's compiled ESM to a CJS-style function body (its output is a constrained shape),
// evals it with a `__require` closure, and renders the default export. This is the real render loop
// running in the browser — no bundler, no server.
function eval_module(code: string, req: (spec: string) => Record<string, unknown>): Record<string, unknown> {
	const body = code
		// import * as X from 'y' [with {...}]
		.replace(/import\s+\*\s+as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const $1 = __require("$2");')
		// import D, { a, b } from 'y'
		.replace(/import\s+([\w$]+)\s*,\s*\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const __m_$1 = __require("$3"); const $1 = __m_$1.default; const {$2} = __m_$1;')
		// import D from 'y' [with {...}]
		.replace(/import\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const $1 = (__require("$2")).default;')
		// import { a, b } from 'y'
		.replace(/import\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const {$1} = __require("$2");')
		// import 'y' (side-effect)
		.replace(/import\s+['"][^'"]+['"]\s*;?/g, '')
		// export default X
		.replace(/export\s+default\s+/g, '__exports.default = ')
		// export { a, b as c }
		.replace(/export\s*\{([^}]+)\}\s*;?/g, (_m, names: string) =>
			names
				.split(',')
				.map((n) => {
					const parts = n.trim().split(/\s+as\s+/);
					const local = parts[0].trim();
					const exported = (parts[1] || parts[0]).trim();
					return local ? `__exports[${JSON.stringify(exported)}] = ${local};` : '';
				})
				.join(' ')
		)
		// export const/let/var/function/class
		.replace(/export\s+(const|let|var|function|class)\s+/g, '$1 ');
	const __exports: Record<string, unknown> = {};
	// eslint-disable-next-line no-new-func
	new Function('__require', '__exports', body)(req, __exports);
	return __exports;
}

/** Compile EVERY file to client JS for the interactive (mounted) preview on the main thread. */
function client_bundle(files: Record<string, string>, entry: string): Analysis['client'] {
	try {
		const modules: Record<string, string> = {};
		for (const [name, code] of Object.entries(files)) {
			if (!name.endsWith('.svelte')) continue;
			// dev:false — avoids `App[$.FILENAME] = …` (a module-scope reference to the default export,
			// which our function-expression eval can't satisfy). Production client is fully interactive.
			const { js } = compile(code, { filename: name, generate: 'client', dev: false }) as {
				js: { code: string };
			};
			modules[name] = js.code;
		}
		return { entry, modules };
	} catch (e) {
		return { entry, modules: {}, error: e instanceof Error ? e.message : String(e) };
	}
}

/** Resolve an import specifier to a key in the file map (`./Counter.svelte` → `Counter.svelte`). */
function resolve_file(spec: string, files: Record<string, string>): string | null {
	const bare = spec.replace(/^\.\//, '').replace(/^\//, '');
	if (files[bare] != null) return bare;
	const base = spec.split('/').pop();
	if (base && files[base] != null) return base;
	return null;
}

/** Boundary-lens metadata per island file — kind/wake/bytes, so the render can mark each region. */
type IslandInfo = Map<string, { kind: string; wake: string; name: string; bytes: number; ships: boolean }>;

/** Render the ENTRY component to SSR HTML, resolving `./X.svelte` imports across the file MAP (they
 *  render as their real components). Imports not in the map (or `ogygia/internal`) render as labelled
 *  stubs. Marked regions are wrapped in an invisible `<ogygia-obs-island>` boundary so the BOUNDARY
 *  LENS can x-ray the output (dead shell vs live island). The compile→link→render loop, in-browser. */
function execute(files: Record<string, string>, entry: string, islandInfo?: IslandInfo): Analysis['rendered'] {
	const stubs = new Set<string>();
	const cache = new Map<string, Record<string, unknown>>();
	const wire: NonNullable<Analysis['rendered']>['wire'] = [];
	const esc = (s: string) => s.replace(/"/g, '&quot;');
	// The props a marked region actually RECEIVES, devalue-encoded — exactly what crosses the boundary
	// by VALUE. `children` (a snippet) and functions never cross, so strip them (matches the wire law).
	const wire_payload = (props: unknown): string => {
		const crossing: Record<string, unknown> = {};
		for (const [k, v] of Object.entries((props as Record<string, unknown>) || {})) {
			// `children`/snippets and functions never cross; `$$slots`/`$$events` are svelte's own
			// slot bookkeeping, not user props — none of them are part of the ogygia wire.
			if (k === 'children' || k.startsWith('$$') || typeof v === 'function') continue;
			crossing[k] = v;
		}
		try {
			return devalue_stringify(crossing);
		} catch {
			try {
				return JSON.stringify(crossing);
			} catch {
				return '{}';
			}
		}
	};
	// Wrap a compiled server component so its render is bracketed by a boundary marker (display:contents,
	// invisible to layout) carrying the region's strategy — the raw material the lens tints + labels.
	// The same seam captures the WIRE payload (the props that cross to this island).
	const with_boundary = (exports: Record<string, unknown>, info: NonNullable<ReturnType<IslandInfo['get']>>): Record<string, unknown> => {
		const Real = exports.default as (r: { push: (s: string) => void }, p: unknown) => void;
		const Marked = ($$renderer: { push: (s: string) => void }, props: unknown) => {
			const payload = wire_payload(props);
			wire.push({ name: info.name, kind: info.kind, payload, bytes: new TextEncoder().encode(payload).length });
			$$renderer.push(
				`<ogygia-obs-island data-obs-island data-kind="${esc(info.kind)}" data-name="${esc(info.name)}" data-wake="${esc(info.wake)}" data-bytes="${info.bytes}" data-ships="${info.ships}">`
			);
			Real($$renderer, props);
			$$renderer.push('</ogygia-obs-island>');
		};
		return { ...exports, default: Marked };
	};
	try {
		const make_require = (): ((spec: string) => Record<string, unknown>) => {
			const require = (spec: string): Record<string, unknown> => {
				if (spec === 'svelte/internal/server') return svelteInternalServer as Record<string, unknown>;
				if (spec === 'svelte/server') return { render } as Record<string, unknown>;
				const file = resolve_file(spec, files);
				if (file && file.endsWith('.svelte')) {
					const info = islandInfo?.get(file);
					const hit = cache.get(file);
					if (hit) return info ? with_boundary(hit, info) : hit;
					const { js } = compile(files[file], { filename: file, generate: 'server', dev: false }) as {
						js: { code: string };
					};
					const exports: Record<string, unknown> = {};
					cache.set(file, exports); // set before eval (tolerate cycles)
					Object.assign(exports, eval_module(js.code, require));
					return info ? with_boundary(exports, info) : exports;
				}
				// not provided (a component the user hasn't added, or ogygia/internal) → labelled stub
				const name = (spec.split('/').pop() || spec).replace(/\.svelte$/, '');
				stubs.add(name);
				const Stub = ($$renderer: { push: (s: string) => void }) =>
					$$renderer.push(`<span class="og-stub" data-og-stub="${name}">‹${name}/›</span>`);
				return { default: Stub };
			};
			return require;
		};
		if (files[entry] == null) return { ok: false, error: `no entry file '${entry}'` };
		const { js } = compile(files[entry], { filename: entry, generate: 'server', dev: false }) as {
			js: { code: string };
		};
		const mod = eval_module(js.code, make_require());
		const Component = mod.default as unknown;
		if (typeof Component !== 'function') return { ok: false, error: 'no default component export' };
		const out = render(Component as never, { props: {} }) as { body?: string; html?: string };
		return { ok: true, html: out.body ?? out.html ?? '', stubs: [...stubs], wire };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e), stubs: [...stubs], wire };
	}
}

/** BYTE LEDGER — weigh the ogygia thesis live. Compile every component to client JS; ogygia ships only
 *  the waking islands (csr=false), plain Kit (csr=true) ships them all. Same compiler, honest bytes. */
function byte_ledger(files: Record<string, string>): NonNullable<Analysis['ledger']> {
	const svelteFiles = Object.keys(files).filter((n) => n.endsWith('.svelte'));
	const bytesOf = (name: string): number => {
		try {
			const { js } = compile(files[name], { filename: name, generate: 'client', dev: false }) as {
				js: { code: string };
			};
			return new TextEncoder().encode(js.code).length;
		} catch {
			return 0;
		}
	};
	// Collect every marked import across ALL files → which target components ship, and why.
	const reason = new Map<string, { ships: boolean; why: string }>();
	for (const f of svelteFiles) {
		const marks = analyze_marks(files[f]);
		for (const isl of marks.islands) {
			const k = isl.strategy.kind;
			const ships = k === 'island' || k === 'preset';
			const target = resolve_file(isl.component, files);
			if (!target) continue;
			const why = ships
				? `island · wakes on '${(isl.attrs.wake as string) || 'load'}'`
				: k === 'lake'
					? 'lake · frozen SSR, no JS'
					: k === 'server hole'
						? 'server hole · HTML from endpoint'
						: k === 'held (raw)'
							? 'held raw · server HTML, no JS'
							: k === 'live'
								? 'live · baked HTML, revalidates'
								: 'server HTML only';
			// an island mark wins over a non-shipping mark if the same file is imported both ways
			if (!reason.has(target) || ships) reason.set(target, { ships, why });
		}
	}
	const filesOut = svelteFiles.map((name) => {
		const bytes = bytesOf(name);
		const r = reason.get(name);
		const ships = r?.ships ?? false;
		const why =
			r?.why ??
			(name === 'App.svelte' ? 'page shell · server HTML only' : 'unmarked · free server HTML');
		return { name, bytes, ships, why };
	});
	const ogygiaBytes = filesOut.filter((f) => f.ships).reduce((s, f) => s + f.bytes, 0);
	const kitBytes = filesOut.reduce((s, f) => s + f.bytes, 0);
	return {
		files: filesOut,
		ogygiaBytes,
		kitBytes,
		ogygiaCount: filesOut.filter((f) => f.ships).length,
		kitCount: filesOut.length
	};
}

/** REAL ISLANDS — render the app so each waking island becomes a genuine `<ogygia-region>` shell (with
 *  its isolated SSR + a devalue prop sidecar), wrapped in `<ogygia-slot>` so the page's own runtime
 *  self-runs + hydrates it (a bare region nested in the Observatory's awake island would be skipped).
 *  The `entry` is a `__ISLAND__:<file>` placeholder the MAIN thread rewrites to a blob of the linked
 *  client component. Only islands (kind island/preset) get a region; everything else renders inline. */
function real_island_render(files: Record<string, string>, entry: string, islandInfo: IslandInfo): Analysis['realDom'] {
	const cache = new Map<string, Record<string, unknown>>();
	const usedIslands = new Set<string>();
	const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
	const escScript = (s: string) => s.replace(/<\//g, '<\\/');
	// Islands captured during the app render; rendered in ISOLATION afterwards (no re-entrant render()).
	const captured: Array<{ info: NonNullable<ReturnType<IslandInfo['get']>>; Comp: unknown; props: Record<string, unknown> }> = [];
	// Server islands (render: 'deferred') captured the same way; their HTML is served via a fetch intercept.
	const deferred: Array<{ info: NonNullable<ReturnType<IslandInfo['get']>>; Comp: unknown; props: Record<string, unknown> }> = [];
	const deferredHtml: Record<string, string> = {};
	// Live regions (render: 'live') — first paint baked here; the main thread ticks re-renders in via applyLive.
	const live: Array<{ info: NonNullable<ReturnType<IslandInfo['get']>>; Comp: unknown; props: Record<string, unknown> }> = [];
	const liveOut: NonNullable<Analysis['realDom']>['live'] = [];
	try {
		const require = (spec: string): Record<string, unknown> => {
			if (spec === 'svelte/internal/server') return svelteInternalServer as Record<string, unknown>;
			if (spec === 'svelte/server') return { render } as Record<string, unknown>;
			const file = resolve_file(spec, files);
			if (file && file.endsWith('.svelte')) {
				const info = islandInfo.get(file);
				const isWakingIsland = info && (info.kind === 'island' || info.kind === 'preset');
				const isServerHole = info && info.kind === 'server hole';
				const isLive = info && info.kind === 'live';
				const built = () => {
					const hit = cache.get(file);
					if (hit) return hit;
					const { js } = compile(files[file], { filename: file, generate: 'server', dev: false }) as { js: { code: string } };
					const exports: Record<string, unknown> = {};
					cache.set(file, exports);
					Object.assign(exports, eval_module(js.code, require));
					return exports;
				};
				const exports = built();
				// Live region → placeholder for a `<ogygia-region live>` (morphs in place each tick).
				if (isLive) {
					const Real = exports.default;
					const Live = ($$renderer: { push: (s: string) => void }, props: Record<string, unknown>) => {
						const idx = live.length;
						live.push({ info: info!, Comp: Real, props: props || {} });
						usedIslands.add(file);
						$$renderer.push(`<!--OBS_LIVE:${idx}-->`);
					};
					return { ...exports, default: Live };
				}
				// Server island → placeholder for a DEFERRED region (HTML fetched later on schedule).
				if (isServerHole) {
					const Real = exports.default;
					const Deferred = ($$renderer: { push: (s: string) => void }, props: Record<string, unknown>) => {
						const idx = deferred.length;
						deferred.push({ info: info!, Comp: Real, props: props || {} });
						usedIslands.add(file);
						$$renderer.push(`<!--OBS_DEFER:${idx}-->`);
					};
					return { ...exports, default: Deferred };
				}
				if (!isWakingIsland) return exports;
				// Waking island → emit a placeholder comment now; capture (Comp, props) to render in
				// isolation after the app render. Index by captured.length so each placement is distinct.
				const Real = exports.default;
				const Marked = ($$renderer: { push: (s: string) => void }, props: Record<string, unknown>) => {
					const idx = captured.length;
					captured.push({ info: info!, Comp: Real, props: props || {} });
					usedIslands.add(file);
					$$renderer.push(`<!--OBS_ISLAND:${idx}-->`);
				};
				return { ...exports, default: Marked };
			}
			// unprovided component → inert inline stub (keeps the render alive)
			const name = (spec.split('/').pop() || spec).replace(/\.svelte$/, '');
			return { default: ($$r: { push: (s: string) => void }) => $$r.push(`<span data-og-stub="${name}"></span>`) };
		};
		if (files[entry] == null) return { ok: false, error: `no entry file '${entry}'` };
		const { js } = compile(files[entry], { filename: entry, generate: 'server', dev: false }) as { js: { code: string } };
		const mod = eval_module(js.code, require);
		const App = mod.default as unknown;
		if (typeof App !== 'function') return { ok: false, error: 'no default component export' };
		let html = (render(App as never, { props: {} }) as { body?: string; html?: string }).body ?? '';

		// Replace each placeholder with a real region: <ogygia-slot><ogygia-region …>SSR</…><script props></ogygia-slot>.
		for (let idx = 0; idx < captured.length; idx++) {
			const { info, Comp, props } = captured[idx];
			// isolated SSR of the island (matches what the client component will hydrate against)
			let ssr = '';
			try {
				ssr = (render(Comp as never, { props: props as never }) as { body?: string }).body ?? '';
			} catch {
				ssr = '';
			}
			// the props that cross by value (children/functions/$$ never cross), devalue-encoded
			const crossing: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(props)) {
				if (k === 'children' || k.startsWith('$$') || typeof v === 'function') continue;
				crossing[k] = v;
			}
			let payload = '[{}]';
			try {
				payload = devalue_stringify(crossing);
			} catch {
				/* leave empty */
			}
			const fp = `obsfp_${info.name.replace(/[^\w]/g, '')}_${idx}`;
			const wake = info.wake || 'load';
			const region =
				`<ogygia-slot><ogygia-region entry="${escAttr('__ISLAND__:' + info.name)}" wake="${escAttr(wake)}" ` +
				`data-og-fp="${fp}" data-obs-real-island data-name="${escAttr(info.name)}">${ssr}</ogygia-region>` +
				`<script data-ogygia-props>${escScript(payload)}</script></ogygia-slot>`;
			html = html.replace(`<!--OBS_ISLAND:${idx}-->`, region);
		}

		// Server islands: render each in isolation, stash the HTML (served via the fetch intercept), and
		// emit a DEFERRED region whose endpoint the runtime fetches on its schedule — the real defer flow.
		for (let idx = 0; idx < deferred.length; idx++) {
			const { info, Comp, props } = deferred[idx];
			let body = '';
			try {
				body = (render(Comp as never, { props: props as never }) as { body?: string }).body ?? '';
			} catch {
				body = '';
			}
			deferredHtml[String(idx)] = body;
			const fp = `obsfp_defer_${info.name.replace(/[^\w]/g, '')}_${idx}`;
			const when = info.wake || 'load';
			// endpoint is a same-origin path (passes is_allowed_region_endpoint); the fetch intercept
			// serves deferredHtml[idx]. The fallback shows until the fetch lands (real server-island UX).
			const region =
				`<ogygia-region render="defer" when="${escAttr(when)}" endpoint="/__obs_defer/${idx}" ` +
				`data-og-fp="${fp}" data-obs-real-island data-obs-deferred data-name="${escAttr(info.name)}">` +
				`<span class="obs-fallback">loading ${escAttr(info.name.replace(/\.svelte$/, ''))}…</span></ogygia-region>`;
			html = html.replace(`<!--OBS_DEFER:${idx}-->`, region);
		}

		// Live regions: bake the first paint into a `<ogygia-region live>`; the main thread ticks
		// re-renders in via applyLive() (morph in place — a live feed that keeps focus/typed text).
		for (let idx = 0; idx < live.length; idx++) {
			const { info, Comp, props } = live[idx];
			let body = '';
			try {
				body = (render(Comp as never, { props: props as never }) as { body?: string }).body ?? '';
			} catch {
				body = '';
			}
			const fp = `obsfp_live_${info.name.replace(/[^\w]/g, '')}_${idx}`;
			liveOut.push({ fp, file: info.name, name: info.name });
			const region =
				`<ogygia-region live data-og-fp="${fp}" data-obs-real-island data-obs-live data-name="${escAttr(info.name)}">` +
				`${body}</ogygia-region>`;
			html = html.replace(`<!--OBS_LIVE:${idx}-->`, region);
		}

		return { ok: true, html, islands: [...usedIslands], deferred: deferredHtml, live: liveOut };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

async function analyze(files: Record<string, string>, active: string): Promise<Analysis> {
	const source = files[active] ?? '';
	const marks = analyze_marks(source);
	const t0 = now();

	// ── run the REAL ogygia transform, in-browser ──
	let real = false;
	let realCode = '';
	let realClientCode: string | undefined;
	let compiledServer: string | undefined;
	let compiledError: string | undefined;
	let realIslands: number | null = null;
	let modules: Analysis['modules'];
	let realError: string | undefined;
	let oxc: Analysis['oxc'];
	try {
		const mod = await ensure_oxc();
		// oxc probe (sync parseSync proves the browser parser)
		try {
			const content = (parse(source, { modern: true }) as { instance?: { content?: { start?: number; end?: number } } })
				.instance?.content;
			const script =
				content && content.start != null && content.end != null ? source.slice(content.start, content.end) : '';
			const res = mod.parseSync('host.ts', script) as { program?: { body?: Array<{ type: string }> }; errors?: unknown[] };
			const body = res.program?.body ?? [];
			const errs = res.errors ?? [];
			oxc = { engine: 'rolldown-browser (oxc/wasm)', ok: errs.length === 0, imports: body.filter((n) => n.type === 'ImportDeclaration').length };
		} catch {
			oxc = { engine: 'rolldown-browser (oxc/wasm)', ok: false, imports: 0 };
		}

		const result = transformHost(source, '/repl/src/routes/App.svelte', build_ctx(true)) as {
			code?: string;
			islands?: Array<{
				id?: string;
				componentPath?: string;
				kind?: string;
				wrapperPath?: string;
				wrapperSource?: string;
				virtualPath?: string;
				source?: string;
			}>;
		} | null;
		if (result && typeof result.code === 'string') {
			real = true;
			realCode = result.code;
			const list = result.islands ?? [];
			realIslands = list.length;
			const base0 = (p?: string) => (p ? p.split('?')[0].split('/').pop() || p : '');
			modules = list.map((isl) => ({
				id: isl.id ?? '',
				component: base0(isl.componentPath),
				kind: isl.kind ?? '',
				wrapperPath: isl.wrapperPath,
				wrapperSource: isl.wrapperSource,
				entryPath: isl.virtualPath,
				entrySource: isl.source
			}));
			// Overlay the REAL md5 region ids onto the (nicely-labelled) mark islands, matched by
			// component basename — so the map shows the build's actual ids, not the FNV placeholder.
			const base = (p?: string) => (p ? p.split('?')[0].split('/').pop() || p : '');
			const realById = new Map<string, string>();
			for (const isl of list) if (isl.componentPath && isl.id) realById.set(base(isl.componentPath), isl.id);
			for (const isl of marks.islands) {
				const rid = realById.get(base(isl.component));
				if (rid) {
					isl.id = rid;
					(isl as Island & { real?: boolean }).real = true;
				}
			}
			// The CLIENT leg (ssr=false): on a csr=false page the client gets stubs, not the wrapper.
			try {
				const clientResult = transformHost(source, '/repl/src/routes/App.svelte', build_ctx(false)) as {
					code?: string;
				} | null;
				if (clientResult && typeof clientResult.code === 'string') realClientCode = clientResult.code;
			} catch {
				/* client leg is best-effort */
			}
		}

		// The LAST step: compile the transformed host with svelte itself (server JS) — the full pipeline
		// source → ogygia transform → svelte compile → shipped code, all in the browser.
		if (real) {
			try {
				const { js } = compile(realCode, {
					filename: 'App.svelte',
					generate: 'server',
					dev: true
				}) as { js: { code: string } };
				compiledServer = js.code;
			} catch (e) {
				compiledError = e instanceof Error ? e.message : String(e);
			}
		}
	} catch (e) {
		realError = e instanceof Error ? `${e.message}` : String(e);
	}

	const entryFile = 'App.svelte' in files ? 'App.svelte' : active;
	const ledger = byte_ledger(files);
	// Boundary-lens metadata: for every marked region, its strategy + bytes, keyed by target file.
	const islandInfo: IslandInfo = new Map();
	for (const f of Object.keys(files)) {
		if (!f.endsWith('.svelte')) continue;
		for (const isl of analyze_marks(files[f]).islands) {
			const target = resolve_file(isl.component, files);
			if (!target) continue;
			const lf = ledger.files.find((x) => x.name === target);
			islandInfo.set(target, {
				kind: isl.strategy.kind,
				wake: (isl.attrs.wake as string) || (isl.strategy.kind === 'island' ? 'load' : ''),
				name: target,
				bytes: lf?.bytes ?? 0,
				ships: lf?.ships ?? false
			});
		}
	}

	return {
		ok: marks.ok,
		error: marks.error,
		islands: marks.islands,
		output: real ? realCode : marks.output,
		outputClient: realClientCode,
		compiledServer,
		compiledError,
		real,
		realIslands,
		modules,
		realError,
		oxc,
		rendered: execute(files, entryFile, islandInfo),
		realDom: real_island_render(files, entryFile, islandInfo),
		client: client_bundle(files, entryFile),
		ledger,
		ms: now() - t0
	};
}

/** LIVE REGIONS: render ONE component (with props) to HTML — the per-tick body the main thread pushes
 *  into a `<ogygia-region live>` via applyLive(), which morphs it in place (keeping focus/typed text). */
function render_live(files: Record<string, string>, file: string, props: Record<string, unknown>): string {
	const cache = new Map<string, Record<string, unknown>>();
	const require = (spec: string): Record<string, unknown> => {
		if (spec === 'svelte/internal/server') return svelteInternalServer as Record<string, unknown>;
		if (spec === 'svelte/server') return { render } as Record<string, unknown>;
		const f = resolve_file(spec, files);
		if (f && f.endsWith('.svelte')) {
			const hit = cache.get(f);
			if (hit) return hit;
			const { js } = compile(files[f], { filename: f, generate: 'server', dev: false }) as { js: { code: string } };
			const ex: Record<string, unknown> = {};
			cache.set(f, ex);
			Object.assign(ex, eval_module(js.code, require));
			return ex;
		}
		return { default: () => {} };
	};
	try {
		if (files[file] == null) return '';
		const { js } = compile(files[file], { filename: file, generate: 'server', dev: false }) as { js: { code: string } };
		const mod = eval_module(js.code, require);
		const Comp = mod.default as unknown;
		if (typeof Comp !== 'function') return '';
		return (render(Comp as never, { props: props as never }) as { body?: string }).body ?? '';
	} catch {
		return '';
	}
}

type InMsg =
	| { id: number; type?: 'analyze'; files: Record<string, string>; active: string }
	| { id: number; type: 'live'; files: Record<string, string>; file: string; props: Record<string, unknown> };

self.onmessage = (e: MessageEvent<InMsg>) => {
	const msg = e.data;
	if (msg.type === 'live') {
		self.postMessage({ id: msg.id, type: 'live', html: render_live(msg.files, msg.file, msg.props) });
		return;
	}
	analyze(msg.files, msg.active).then((result) => self.postMessage({ id: msg.id, result }));
};
