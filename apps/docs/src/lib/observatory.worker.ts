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
	set_parser,
	set_host,
	run_browser_macros
} from 'ogygia/internal/compiler-browser';
import { cdnPlugin, makeCdnCache, CSS_MODULE, css_inject_module } from './repl/cdn-plugin.ts';
import { sveltePlugin } from './repl/svelte-plugin.ts';
import { markdownPlugin, md_to_svelte, md_to_svelte_islands, MD_MODULE, configure_content } from './repl/markdown-plugin.ts';
import { parse_config_markdown, parse_config, type ConfigNote } from './repl/repl-config.ts';
import { make_browser_host } from './repl/browser-host.ts';
import { resolve_file } from './repl/resolve-file.ts';
import { make_ogygia_server_module, make_ogygia_internal_module } from './repl/og-server.ts';
import type { ReplDriver, DriverRegion, DriverCodecs, DriverManifests, DriverCsrSummary } from './repl/full-driver.ts';

// The FULL ogygia compiler driver (complete macros + transportable manifests + csr legs). Loaded
// lazily inside the `drivetest` handler — a static import would drag the whole driver graph onto the
// worker's boot path, so a plain analyze/preview session never pays for it.
let repl_driver: ReplDriver | null = null;
async function get_repl_driver(): Promise<ReplDriver> {
	if (!repl_driver) {
		const { ReplDriver } = await import('./repl/full-driver.ts');
		repl_driver = new ReplDriver();
	}
	return repl_driver;
}

// The real ogygia server-runtime modules the SSR eval sees — held regions render for real (no stub).
const OGYGIA_SERVER = make_ogygia_server_module();
const OGYGIA_INTERNAL = make_ogygia_internal_module();

// Install the browser compiler HOST once, synchronously, before any transform/hash runs: region ids
// (md5) + content region/fence keys (sha256) now hash through a vendored, node:crypto-verified impl —
// no reliance on Vite incidentally polyfilling node:crypto, and BuildCache disables itself (throwing fs).
set_host(make_browser_host());

// A jsdelivr cache that LIVES for the worker session — an edit re-bundles, but package.json + files
// already fetched are reused (a REPL edits constantly; re-fetching each keystroke would hammer the CDN).
const cdn_cache = makeCdnCache();

// PERSISTENT layer: fetched jsdelivr responses survive across page reloads / shared-link opens via the
// Cache API, so re-opening a workspace with CDN deps is instant instead of re-fetching every package.
// jsdelivr versioned URLs are immutable (safe to keep forever); a no-version `/npm/<name>/package.json`
// resolves to LATEST, so it's NOT persisted (else it'd pin a stale latest). Graceful: any Cache API
// failure falls straight back to the network.
const CDN_CACHE_NAME = 'observatory-cdn-v1';
const CDN_NO_VERSION_PKG = /\/npm\/(?:@[^/]+\/)?[^/@]+\/package\.json(\?|$)/;
async function caching_fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
	if (typeof caches === 'undefined' || CDN_NO_VERSION_PKG.test(url)) return fetch(input as RequestInfo, init);
	try {
		const cache = await caches.open(CDN_CACHE_NAME);
		const hit = await cache.match(url);
		if (hit) return hit;
		const res = await fetch(input as RequestInfo, init);
		if (res.ok) cache.put(url, res.clone()).catch(() => {});
		return res;
	} catch {
		return fetch(input as RequestInfo, init);
	}
}

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
	/** The transformed host as a csr=TRUE route would compile: ogygia steps aside — island directives
	 *  stripped to plain imports, Kit hydrates the whole tree. The csr switch shows this instead. */
	outputCsrTrue?: string;
	/** The transformed host, COMPILED by svelte to server JS — the last step of the pipeline. */
	compiledServer?: string;
	compiledError?: string;
	/** Whether the output came from the real ogygia transformHost (vs the mark-only fallback). */
	real: boolean;
	/** True when the three legs (output/outputClient/outputCsrTrue) came from the FULL compiler driver
	 *  — the complete pipeline (every macro incl. `$`/`store` + the transportable-registration manifest),
	 *  not the lean `transformHost` (which skips those). Lets the Output view flag partial vs complete. */
	driverComplete?: boolean;
	/** The driver's REAL virtual-module registry (Regions view): true content-hashed island/region ids,
	 *  roles (entry/wrapper/region), scheduling kinds, and generated SSR/client leg sources. Present only
	 *  when the full driver ran; the map table + generated-modules panel prefer it over the lean scan. */
	regions?: DriverRegion[];
	/** The driver's REAL wire graph (Wire view): transportable classes, `import.meta.og.$` fn refs, and
	 *  the active runtime feature marks. Present only when the full driver ran. */
	codecs?: DriverCodecs;
	/** The driver's REAL generated manifest module sources (Wire view): transportables / transport / fn /
	 *  server / runtime-entry — the exact modules a build emits. Present only when the full driver ran. */
	manifests?: DriverManifests;
	/** The csr=TRUE leg's collapse summary (Regions view): how much of the island machinery survives when
	 *  ogygia steps aside and plain Kit hydrates the whole page. Present only when the full driver ran. */
	csr?: DriverCsrSummary;
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
	/** Deliberate notes about anything the workspace vite.config asks for that the in-browser preview
	 *  can't apply (build-time keys, unknown/illegal markdown options, un-runnable imports). */
	configNotes?: ConfigNote[];
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

/** The browser HostCtx — mirrors what the driver builds, with fs/path shimmed. `routeCsr` is the
 *  tri-state: false → islands (ogygia); true → csr=true host (strip islands to plain, Kit hydrates). */
function build_ctx(ssr: boolean, routeCsr: boolean = false) {
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
		routeCsr,
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
	// A named-import list → a valid destructuring list: `a, b as c` → `a, b: c` (ES `import {b as c}`
	// aliases to `b`, but object destructuring renames with `:`). The driver's generated modules use
	// renamed imports (`import { makeRegionEndpoint as __ogRegionSign }`).
	const names = (list: string) =>
		list
			.split(',')
			.map((n) => {
				const m = n.trim().match(/^([\w$]+)\s+as\s+([\w$]+)$/);
				return m ? `${m[1]}: ${m[2]}` : n.trim();
			})
			.filter(Boolean)
			.join(', ');
	const body = code
		// import * as X from 'y' [with {...}]
		.replace(/import\s+\*\s+as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const $1 = __require("$2");')
		// import D, { a, b } from 'y'
		.replace(/import\s+([\w$]+)\s*,\s*\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, (_m, d: string, list: string, spec: string) => `const __m_${d} = __require("${spec}"); const ${d} = __m_${d}.default; const {${names(list)}} = __m_${d};`)
		// import D from 'y' [with {...}]
		.replace(/import\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const $1 = (__require("$2")).default;')
		// import { a, b } from 'y'
		.replace(/import\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, (_m, list: string, spec: string) => `const {${names(list)}} = __require("${spec}");`)
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

/** Boundary-lens metadata per island file — kind/wake/bytes, so the render can mark each region. */
type IslandInfo = Map<string, { kind: string; wake: string; name: string; bytes: number; ships: boolean; keep?: string }>;

/** Boundary-lens + strategy metadata for every marked region across the file map, keyed by target
 *  file. Reused by execute (SSR preview) + real_island_render (islands mode) + render_page (nav). */
function build_island_info(files: Record<string, string>): IslandInfo {
	const ledger = byte_ledger(files);
	const info: IslandInfo = new Map();
	for (const f of Object.keys(files)) {
		// `.svelte` hosts, AND `.md`/`.svx` content pages (their dial-preserved svelte view carries the
		// island marks) — so an island authored inside prose is detected + wakes in islands mode.
		if (!f.endsWith('.svelte') && !MD_MODULE.test(f)) continue;
		for (const isl of analyze_marks(files[f]).islands) {
			const target = resolve_file(isl.component, files);
			if (!target) continue;
			const lf = ledger.files.find((x) => x.name === target);
			info.set(target, {
				kind: isl.strategy.kind,
				wake: (isl.attrs.wake as string) || (isl.strategy.kind === 'island' ? 'load' : ''),
				name: target,
				bytes: lf?.bytes ?? 0,
				ships: lf?.ships ?? false,
				keep: typeof isl.attrs.keep === 'string' ? isl.attrs.keep : undefined
			});
		}
	}
	return info;
}

/** Render ONE page (entry) to real-island HTML — used for the initial render AND for a nav target. */
function render_page(files: Record<string, string>, entry: string): Analysis['realDom'] {
	// Must NEVER throw: this runs synchronously inside the worker's postMessage reply, so a throw here
	// posts no `page` message — and the main thread's pageWaiters promise (a pending navigation) would
	// hang forever and leak. A hostile/malformed file that trips the compiler just yields no render.
	try {
		return real_island_render(files, entry, build_island_info(files));
	} catch {
		return undefined;
	}
}

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
				// The REAL ogygia runtime where we have it — region()/isRegion + a server <Region> (held
				// regions render inline, zero JS) from 'ogygia', og_html_region from 'ogygia/internal'.
				// Everything else (content wrappers TabGroup/Tab/… — islands) falls back to a passthrough
				// (children + optional label, stacked) so a `::: tabs` page shows its content, not a crash.
				if (spec === 'ogygia' || spec.startsWith('ogygia/')) {
					const Passthrough = ($$renderer: { push: (s: string) => void }, props?: Record<string, unknown>) => {
						if (props?.label) $$renderer.push(`<div class="repl-passthrough-label">${esc(String(props.label))}</div>`);
						const kids = props?.children;
						if (typeof kids === 'function') (kids as (r: unknown) => void)($$renderer);
					};
					const real =
						spec === 'ogygia/internal' || spec === 'ogygia/internal/register'
							? OGYGIA_INTERNAL
							: spec === 'ogygia'
								? OGYGIA_SERVER
								: {};
					return new Proxy({ default: Passthrough, ...real } as Record<string | symbol, unknown>, {
						get: (t, k) => (k in t ? t[k] : Passthrough)
					}) as Record<string, unknown>;
				}
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
			// The REAL ogygia runtime: region()/isRegion + a server <Region> that renders a held region
			// inline (zero JS). `region('raw' component)` never signs on this path — see og-server.ts.
			if (spec === 'ogygia/internal' || spec === 'ogygia/internal/register') return OGYGIA_INTERNAL;
			if (spec === 'ogygia') return OGYGIA_SERVER;
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
			// `keep: 'name'` → the REAL data-ogygia-keep, so the runtime sets up the keep-host on hydrate
			// and reconcile_body matches + relocates the LIVE island across a nav (its state survives).
			const keepAttr = info.keep ? ` data-ogygia-keep="${escAttr(info.keep)}"` : '';
			const region =
				`<ogygia-slot><ogygia-region entry="${escAttr('__ISLAND__:' + info.name)}" wake="${escAttr(wake)}" ` +
				`data-og-fp="${fp}" data-obs-real-island data-name="${escAttr(info.name)}"${keepAttr}>${ssr}</ogygia-region>` +
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

/** The workspace's vite.config source, if any (checked in ts/js/mjs order). */
function config_source(files: Record<string, string>): string | null {
	return files['vite.config.ts'] ?? files['vite.config.js'] ?? files['vite.config.mjs'] ?? null;
}

/** Configure the content pipeline from a workspace `vite.config.*`'s `ogygia({ content: { markdown } })`
 *  — the REPL user tunes the preview exactly as a real project does. Idempotent per config signature. */
function apply_content_config(files: Record<string, string>): void {
	const src = config_source(files);
	configure_content(src ? parse_config_markdown(src) : null);
}

/** Deliberate notes on anything the workspace vite.config asks for that the in-browser preview can't
 *  apply — surfaced in the UI so the user knows what's allowed and what to change. */
function config_notes(files: Record<string, string>): ConfigNote[] {
	const src = config_source(files);
	return src ? parse_config(src).notes : [];
}

/** Run the REAL module-macro passes (`import.meta.og.wire` + `.code`/`.md`) over the workspace BEFORE
 *  either the transform or the svelte compile sees it — exactly as a real build does (the compiler owns
 *  the passes; the REPL just calls them). `.code`/`.md` bake through the app's own Shiki/mdsvex config
 *  and inline `og_html_region(…)`; the runtime `og_html_region`/`Region` are provided real, not stubbed. */
async function macro_files(files: Record<string, string>): Promise<Record<string, string>> {
	// Only spin up the parser + run the passes when a macro marker is actually present anywhere.
	if (!Object.values(files).some((s) => s.includes('import.meta.og.'))) return files;
	await ensure_oxc(); // the macro passes parse with the oxc/WASM parser — install it before they run
	const cfg_src = config_source(files);
	const md_cfg = (cfg_src ? parse_config_markdown(cfg_src) : null) as Parameters<typeof run_browser_macros>[2];
	let changed = false;
	const out: Record<string, string> = { ...files };
	for (const name of Object.keys(files)) {
		const src = files[name];
		// Fast skip: only .svelte/.ts/.js hosts, and only when a macro marker is actually present.
		if (!/\.(svelte|ts|js)$/.test(name) || !src.includes('import.meta.og.')) continue;
		try {
			const { code, touched } = await run_browser_macros(src, '/repl/' + name.replace(/^\/+/, ''), md_cfg);
			if (touched) {
				out[name] = code;
				changed = true;
			}
		} catch {
			/* a malformed macro call → leave the source as-is; the error surfaces at compile downstream */
		}
	}
	return changed ? out : files;
}

/** A "svelte view" of the workspace: every `.md` / `.svx` file replaced by its markdown-pipeline Svelte
 *  source (same key), so the whole sync analyze/SSR machinery treats a content page as a normal component
 *  (mdsvex is async, so this is resolved ONCE up front). Non-content files pass through untouched. */
async function content_svelte_view(files: Record<string, string>, keepDials = false): Promise<Record<string, string>> {
	const out: Record<string, string> = { ...files };
	const to_svelte = keepDials ? md_to_svelte_islands : md_to_svelte;
	for (const [name, code] of Object.entries(files)) {
		if (!MD_MODULE.test(name)) continue;
		try {
			out[name] = await to_svelte(code, '/repl/' + name.replace(/^\/+/, ''));
		} catch (e) {
			// A markdown compile error surfaces as a normal svelte-compile error downstream — leave a stub
			// component so `rendered` still resolves (and the error shows) instead of crashing analyze.
			out[name] = `<pre class="og-md-error">markdown error: ${(e instanceof Error ? e.message : String(e)).replace(/[<&]/g, ' ')}</pre>`;
		}
	}
	return out;
}

async function analyze(files: Record<string, string>, active: string): Promise<Analysis> {
	// The ORIGINAL, pre-macro workspace — the FULL compiler driver runs its own macro pipeline, so it
	// must see raw source (not the already-macro'd files below), exactly as a real build's entry does.
	const original_files = files;
	// Apply the workspace's ogygia markdown config (from a vite.config.ts) before compiling any content.
	apply_content_config(files);
	// Run the real `import.meta.og.*` macro passes BEFORE the transform / svelte compile sees the source
	// (exactly as a build does). No-op unless a macro marker is present.
	files = await macro_files(files);
	// Resolve content pages to Svelte source ONCE (mdsvex is async); the rest of analyze is sync + treats
	// a `.md`/`.svx` entry exactly like a `.svelte` component.
	const svelte_files = await content_svelte_view(files);
	const source = svelte_files[active] ?? '';
	const marks = analyze_marks(source);
	const t0 = now();

	// ── run the REAL ogygia transform, in-browser ──
	let real = false;
	let realCode = '';
	let realClientCode: string | undefined;
	let realCsrTrueCode: string | undefined;
	let compiledServer: string | undefined;
	let compiledError: string | undefined;
	let realIslands: number | null = null;
	let modules: Analysis['modules'];
	let driver_regions: DriverRegion[] | undefined;
	let driver_codecs: DriverCodecs | undefined;
	let driver_manifests: DriverManifests | undefined;
	let driver_csr: DriverCsrSummary | undefined;
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
				// The build kind is 'hydrate' for every emitted binding — even a held-raw region (its chunk
				// exists only in case it's woken at the `region()` call; it ships zero JS otherwise). Show the
				// friendly strategy label from the marks instead, so the map reads 'held (raw)' / 'lake' / etc.
				kind: marks.islands.find((m) => base0(m.component) === base0(isl.componentPath))?.strategy.kind ?? isl.kind ?? '',
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
			// The csr=TRUE leg: ogygia steps aside — the transform strips island directives to plain.
			try {
				const csrTrue = transformHost(source, '/repl/src/routes/App.svelte', build_ctx(true, true)) as {
					code?: string;
				} | null;
				if (csrTrue && typeof csrTrue.code === 'string') realCsrTrueCode = csrTrue.code;
			} catch {
				/* csr=true leg is best-effort */
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

	// ── The FULL compiler driver: the COMPLETE transform for the Output view ──
	// The lean `transformHost` above still feeds islands / modules / preview, but it skips the `$`/`store`
	// macros and the transportable-registration append. The full driver runs the ENTIRE pipeline, so the
	// three legs it returns show `import.meta.og.$` rewritten, store codecs, and the registration manifest
	// — the compiler OUTPUT the Observatory exists to show. Additive + best-effort: any driver error keeps
	// the lean legs. Guarded to a raw `.svelte` entry (a `.md`/`.svx` entry takes the lean md→svelte path).
	//
	// Only pay for the driver's 3 extra compiler passes when its output would actually DIFFER from the lean
	// legs: the divergence is exactly the `$`/`store` rewrites, a wire codec, or the registration manifest
	// (any `export class`). For plain island code the two are byte-identical, so the lean legs are already
	// the complete output — skip the driver (keeps per-keystroke analyze snappy) and still mark complete.
	const uses_full_only = Object.values(original_files).some(
		(c) =>
			// No trailing `\b` after `$` — `$` is a non-word char, so `\$\b` can never match `…og.$(`.
			/import\.meta\.og\.(?:\$|store)/.test(c) ||
			/\bstatic\s+#?\w+\s*=\s*import\.meta\.og\.wire\b/.test(c) ||
			/\bexport\s+(?:default\s+|abstract\s+)?class\b/.test(c)
	);
	let driverComplete = !uses_full_only; // lean == complete when no full-driver-only feature is present
	if (uses_full_only && active.endsWith('.svelte') && original_files[active] != null) {
		try {
			await ensure_oxc();
			const driver = await get_repl_driver();
			driver.install((id, code) => oxc_mod!.parseSync(id, code));
			const md_for_driver = (() => {
				const s = config_source(original_files);
				return s ? parse_config_markdown(s) : null;
			})();
			const dr = await driver.analyze(original_files, md_for_driver, active);
			if (!dr.error && dr.ssr != null) {
				real = true;
				realCode = dr.ssr;
				if (dr.client != null) realClientCode = dr.client;
				if (dr.csrTrue != null) realCsrTrueCode = dr.csrTrue;
				driverComplete = true;
				// The REAL registry the SSR leg minted — powers the Regions view (roles/kinds/generated
				// sources) and overlays the true content-hashed ids onto the friendly mark-derived island
				// map (more complete than the lean overlay: it also carries held regions + server islands).
				if (dr.regions) {
					driver_regions = dr.regions;
					const b = (p?: string) => (p ? p.split('?')[0].split('/').pop() || p : '');
					const realById = new Map<string, string>();
					for (const r of dr.regions)
						if ((r.role === 'entry' || r.role === 'region') && r.component && r.id) realById.set(r.component, r.id);
					for (const isl of marks.islands) {
						const rid = realById.get(b(isl.component));
						if (rid) {
							isl.id = rid;
							(isl as Island & { real?: boolean }).real = true;
						}
					}
				}
				if (dr.codecs) driver_codecs = dr.codecs;
				if (dr.manifests) driver_manifests = dr.manifests;
				if (dr.csr) driver_csr = dr.csr;
				// Re-run the LAST pipeline step (svelte → server JS) over the driver's output, so the
				// "compiled" view matches the transform shown above instead of the lean one.
				try {
					const { js } = compile(realCode, { filename: 'App.svelte', generate: 'server', dev: true }) as {
						js: { code: string };
					};
					compiledServer = js.code;
					compiledError = undefined;
				} catch (e) {
					compiledError = e instanceof Error ? e.message : String(e);
				}
			}
		} catch {
			/* keep the lean legs — the full driver is best-effort over the lean transform */
		}
	}

	// The page to render: a Kit route `+page.{svelte,md,svx}` (ogygia is SvelteKit-only), else legacy
	// `App.svelte`, else whatever's open. Mirrors the client's entry_of pick.
	const entryFile =
		Object.keys(svelte_files).find((k) => /(^|\/)\+page\.(svelte|md|svx)$/.test(k)) ??
		('App.svelte' in svelte_files ? 'App.svelte' : active);
	const ledger = byte_ledger(svelte_files);
	// Island detection scans for `with { … }` marks, so it needs the DIAL-PRESERVED content view — else an
	// island authored inside a `.md` (its dial stripped for the compile legs) is invisible and won't wake
	// in islands mode. Non-content files are identical in both views.
	const islandInfo = build_island_info(await content_svelte_view(files, true));
	const rendered = execute(svelte_files, entryFile, islandInfo);
	const realDom = real_island_render(svelte_files, entryFile, islandInfo);
	const client = client_bundle(svelte_files, entryFile);

	return {
		ok: marks.ok,
		error: marks.error,
		islands: marks.islands,
		output: real ? realCode : marks.output,
		outputClient: realClientCode,
		outputCsrTrue: realCsrTrueCode,
		compiledServer,
		compiledError,
		real,
		driverComplete,
		realIslands,
		modules,
		regions: driver_regions,
		codecs: driver_codecs,
		manifests: driver_manifests,
		csr: driver_csr,
		realError,
		oxc,
		// content pages resolved to svelte source above → the sync SSR/island/client legs treat them as
		// normal components (the entry compile keys on the file, not the extension).
		rendered,
		realDom,
		client,
		ledger,
		configNotes: config_notes(files),
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

// Strip ogygia `with { … }` import dials so a `.svelte` compiles as a PLAIN component for the live
// (whole-app) mount — the marked import becomes a normal one; the workspace resolver links it.
const WITH_DIAL = /(\bfrom\s*['"][^'"]+['"])\s*with\s*\{[^}]*\}/g;
const SVELTE_EXTERNAL_ID = /^svelte(\/|$)/;
// ogygia's own runtime (TabGroup/Tab for content tabs, app helpers, …) is EXTERNAL — the host page IS an
// ogygia app, so the main thread hands the eval its OWN already-compiled ogygia modules (bundle_require).
// Never CDN-fetch `ogygia` (the published npm build is a different version + won't recompile in the REPL).
const OGYGIA_EXTERNAL_ID = /^ogygia(\/|$)/;
// rolldown paints errors with ANSI color + a box-drawing source frame — strip both for the REPL readout.
const ANSI = /\x1b\[[0-9;]*m/g;
const BUILD_FAILED = /^Build failed with \d+ errors?:\s*/;

/** Reduce a rolldown build error to a one-line headline the UI can show (no ANSI, no source-frame box). */
function clean_bundle_error(raw: string): string {
	const plain = raw.replace(ANSI, '').replace(BUILD_FAILED, '');
	// Everything before the source-frame box (its top rule starts with `╭`) is the human-readable message.
	const head = plain.split(/\n\s*╭/)[0].trim();
	return (head || plain).replace(/\s+/g, ' ').slice(0, 400);
}

/** The REAL bundle: run rolldown over the workspace (svelte-compiled) + jsdelivr CDN deps, svelte kept
 *  external. Returns a CJS module string the main thread evals + mounts, plus the packages it pulled. */
/** REAL preview SSR, DRIVER-sourced — run the full compiler driver, then eval its EXACT transformed host
 *  graph (host → region binding → wrapper → island entry → component) against the worker-safe island
 *  `Region` shim (og-server), producing genuine `<ogygia-region>` HTML that is the real compiler output
 *  (not the hand-built `real_island_render` shells). This is the SSR half of the two-build driver preview
 *  (Phase 2b); the client island modules + Harness linking follow. */
async function driver_render(
	files: Record<string, string>,
	entry: string
): Promise<{ ok: boolean; html?: string; regions?: DriverRegion[]; error?: string }> {
	await ensure_oxc();
	const driver = await get_repl_driver();
	driver.install((id, code) => oxc_mod!.parseSync(id, code));
	const md = (() => {
		const s = config_source(files);
		return s ? parse_config_markdown(s) : null;
	})();
	const dr = await driver.analyze(files, md, entry);
	if (dr.error || dr.ssr == null || !dr.regions) return { ok: false, error: dr.error ?? 'no driver output' };
	const regionByVpath = new Map(dr.regions.map((r) => [r.vpath, r]));
	const cache = new Map<string, Record<string, unknown>>();
	const cached = (key: string, make: () => Record<string, unknown>): Record<string, unknown> => {
		const hit = cache.get(key);
		if (hit) return hit;
		const exports: Record<string, unknown> = {};
		cache.set(key, exports); // set before eval (tolerate the host↔region↔wrapper cycle)
		Object.assign(exports, make());
		return exports;
	};
	const require = (spec: string): Record<string, unknown> => {
		if (spec === 'svelte/internal/server') return svelteInternalServer as Record<string, unknown>;
		if (spec === 'svelte/server') return { render } as Record<string, unknown>;
		if (spec === 'ogygia/internal' || spec === 'ogygia/internal/register') return OGYGIA_INTERNAL;
		if (spec === 'ogygia') return OGYGIA_SERVER;
		// The region signer / server-island minter — inert in the preview (no signed endpoints).
		if (spec === 'ogygia/internal/server')
			return { makeRegionEndpoint: () => '', mintServerIsland: () => '', known_region_fps: () => new Set() };
		if (spec === 'virtual:ogygia/island-deps')
			return { islandCss: () => '', islandDeps: () => [], contentCss: () => '' };
		// A driver-generated region/wrapper/island virtual module → eval its real generated source.
		const reg = regionByVpath.get(spec);
		if (reg) {
			return cached(reg.vpath, () => {
				if (reg.role === 'wrapper') {
					const { js } = compile(reg.source ?? '', { filename: 'wrapper.svelte', generate: 'server', dev: false }) as { js: { code: string } };
					return eval_module(js.code, require);
				}
				return eval_module((reg.role === 'region' ? reg.ssrSource : reg.source) ?? '', require);
			});
		}
		// Any other ogygia virtual (transportables/fn-manifest/…) → side-effect no-op in the preview.
		if (spec.startsWith('virtual:ogygia/') || spec.startsWith('ogygia/')) return {};
		// A workspace component (the region binding + wrapper import it by its `/repl/…` absolute path).
		const key = spec.replace(/^\/repl\//, '').replace(/^\/+/, '');
		const file = files[key] != null ? key : resolve_file(spec, files);
		if (file && file.endsWith('.svelte'))
			return cached(file, () => {
				const { js } = compile(files[file], { filename: file, generate: 'server', dev: false }) as { js: { code: string } };
				return eval_module(js.code, require);
			});
		if (file && files[file] != null) return cached(file, () => eval_module(files[file], require));
		return {};
	};
	try {
		const { js } = compile(dr.ssr, { filename: 'App.svelte', generate: 'server', dev: false }) as { js: { code: string } };
		const App = eval_module(js.code, require).default;
		if (typeof App !== 'function') return { ok: false, error: 'driver host has no default component export' };
		const html = (render(App as never, { props: {} }) as { body?: string }).body ?? '';
		return { ok: true, html, regions: dr.regions };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

async function bundle_preview(
	files: Record<string, string>,
	entry: string
): Promise<{ code?: string; packages?: string[]; missing?: string[]; error?: string }> {
	apply_content_config(files); // honour the workspace vite.config's markdown options in the bundle leg too
	files = await macro_files(files); // run the real `import.meta.og.*` macro passes before bundling too
	const rb = (await import('@rolldown/browser')) as {
		rolldown: (o: unknown) => Promise<{ generate: (o: unknown) => Promise<{ output: Array<{ code: string }> }> }>;
	};
	const packages: string[] = [];
	const missing: string[] = [];
	const workspace = {
		name: 'workspace',
		resolveId(id: string, importer: string | undefined) {
			if (files[id] != null) return id; // the entry / an exact workspace key
			return resolve_file(id, files); // relative / $lib / basename → a workspace key, or null
		},
		load(id: string) {
			if (files[id] == null) return null;
			// A workspace `.css` file → the same style-injecting module the CDN loader uses (rolldown can't
			// bundle CSS), forced to moduleType 'js' so the `.css` id isn't rejected.
			if (CSS_MODULE.test(id)) return { code: css_inject_module(files[id], id), moduleType: 'js' };
			return files[id];
		}
	};
	try {
		const bundle = await rb.rolldown({
			input: entry,
			plugins: [
				workspace,
				// `.md` / `.svx` → ogygia's real content pipeline (mdsvex + shiki + admonitions) → svelte JS.
				markdownPlugin({ generate: 'client' }),
				sveltePlugin({ generate: 'client', preprocess: (c: string) => c.replace(WITH_DIAL, '$1') }),
				cdnPlugin({
					cache: cdn_cache, // reused across edits — don't re-fetch jsdelivr every keystroke
					fetch: caching_fetch, // + persisted across reloads via the Cache API
					onPackage: (n: string, v: string) => packages.push(v ? `${n}@${v}` : n),
					onMissing: (id: string) => missing.push(id)
				})
			],
			external: (id: string) => SVELTE_EXTERNAL_ID.test(id) || OGYGIA_EXTERNAL_ID.test(id), // shared w/ host
			cwd: '/',
			onLog() {}
		});
		const { output } = await bundle.generate({ format: 'cjs', exports: 'named' });
		return { code: output[0].code, packages: [...new Set(packages)], missing: [...new Set(missing)] };
	} catch (e) {
		return { error: clean_bundle_error(e instanceof Error ? e.message : String(e)) };
	}
}

type InMsg =
	| { id: number; type?: 'analyze'; files: Record<string, string>; active: string }
	| { id: number; type: 'live'; files: Record<string, string>; file: string; props: Record<string, unknown> }
	| { id: number; type: 'page'; files: Record<string, string>; entry: string }
	| { id: number; type: 'bundle'; files: Record<string, string>; entry: string }
	| { id: number; type: 'drivetest'; files: Record<string, string>; entry: string }
	| { id: number; type: 'driverender'; files: Record<string, string>; entry: string };

self.onmessage = (e: MessageEvent<InMsg>) => {
	const msg = e.data;
	if (msg.type === 'live') {
		self.postMessage({ id: msg.id, type: 'live', html: render_live(msg.files, msg.file, msg.props) });
		return;
	}
	if (msg.type === 'page') {
		// A nav target: render that page to real-island HTML (the mini-router injects + reconciles it).
		self.postMessage({ id: msg.id, type: 'page', realDom: render_page(msg.files, msg.entry) });
		return;
	}
	if (msg.type === 'bundle') {
		// The REAL rolldown bundle for the live preview (workspace + jsdelivr CDN deps). Async (network).
		bundle_preview(msg.files, msg.entry).then((r) => self.postMessage({ id: msg.id, type: 'bundle', ...r }));
		return;
	}
	if (msg.type === 'drivetest') {
		// Prove the FULL driver runs in-worker: install its seams (parser first), run all legs.
		(async () => {
			await ensure_oxc();
			const driver = await get_repl_driver();
			driver.install((id, code) => oxc_mod!.parseSync(id, code));
			const md = (() => { const s = config_source(msg.files); return s ? parse_config_markdown(s) : null; })();
			const result = await driver.analyze(msg.files, md, msg.entry);
			self.postMessage({ id: msg.id, type: 'drivetest', result });
		})().catch((e) => self.postMessage({ id: msg.id, type: 'drivetest', result: { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined, ssr: null, client: null, csrTrue: null } }));
		return;
	}
	if (msg.type === 'driverender') {
		// Prove the DRIVER-sourced SSR: real transformed graph → genuine <ogygia-region> HTML.
		driver_render(msg.files, msg.entry)
			.then((result) => self.postMessage({ id: msg.id, type: 'driverender', result }))
			.catch((e) => self.postMessage({ id: msg.id, type: 'driverender', result: { ok: false, error: e instanceof Error ? e.message : String(e) } }));
		return;
	}
	analyze(msg.files, msg.active).then((result) => self.postMessage({ id: msg.id, result }));
};
