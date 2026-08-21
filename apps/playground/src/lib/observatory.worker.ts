// MUST be first: shims `process` for rolldown-browser's tsconfig helper (runs before it loads).
import './rd-process-shim.ts';
import { parse, compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import * as svelteInternalServer from 'svelte/internal/server';
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
	rendered?: { ok: boolean; html?: string; error?: string; stubs?: string[] };
	/** CLIENT bundle for the INTERACTIVE preview: every file compiled to client JS + the entry, so the
	 *  MAIN thread can link + `mount()` the app (the counter actually works). */
	client?: { entry: string; modules: Record<string, string>; error?: string };
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

/** Render the ENTRY component to SSR HTML, resolving `./X.svelte` imports across the file MAP (they
 *  render as their real components). Imports not in the map (or `ogygia/internal`) render as labelled
 *  stubs. The compile→link→render loop, running in the browser. */
function execute(files: Record<string, string>, entry: string): Analysis['rendered'] {
	const stubs = new Set<string>();
	const cache = new Map<string, Record<string, unknown>>();
	try {
		const make_require = (): ((spec: string) => Record<string, unknown>) => {
			const require = (spec: string): Record<string, unknown> => {
				if (spec === 'svelte/internal/server') return svelteInternalServer as Record<string, unknown>;
				if (spec === 'svelte/server') return { render } as Record<string, unknown>;
				const file = resolve_file(spec, files);
				if (file && file.endsWith('.svelte')) {
					const hit = cache.get(file);
					if (hit) return hit;
					const { js } = compile(files[file], { filename: file, generate: 'server', dev: false }) as {
						js: { code: string };
					};
					const exports: Record<string, unknown> = {};
					cache.set(file, exports); // set before eval (tolerate cycles)
					Object.assign(exports, eval_module(js.code, require));
					return exports;
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
		return { ok: true, html: out.body ?? out.html ?? '', stubs: [...stubs] };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e), stubs: [...stubs] };
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
		rendered: execute(files, 'App.svelte' in files ? 'App.svelte' : active),
		client: client_bundle(files, 'App.svelte' in files ? 'App.svelte' : active),
		ms: now() - t0
	};
}

self.onmessage = (e: MessageEvent<{ id: number; files: Record<string, string>; active: string }>) => {
	const { id, files, active } = e.data;
	analyze(files, active).then((result) => self.postMessage({ id, result }));
};
