// MUST be first: shims `process` for rolldown-browser's tsconfig helper (runs before it loads).
import './rd-process-shim.ts';
import { parse } from 'svelte/compiler';
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
}

export interface Analysis {
	ok: boolean;
	error?: string;
	islands: Island[];
	/** The transformed host — from the REAL transform when it ran, else the svelte-based rewrite. */
	output: string;
	/** Whether the output came from the real ogygia transformHost (vs the mark-only fallback). */
	real: boolean;
	/** Real island count from transformHost (md5 iids), or null. */
	realIslands: number | null;
	/** First real island descriptor (JSON) — for wiring the map to real ids. */
	realSample?: string;
	realError?: string;
	/** Proof the SAME oxc parser (rolldown-browser WASM) the full transform uses runs in-browser. */
	oxc?: { engine: string; ok: boolean; imports: number; error?: string };
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

async function analyze(source: string): Promise<Analysis> {
	const marks = analyze_marks(source);

	// ── run the REAL ogygia transform, in-browser ──
	let real = false;
	let realCode = '';
	let realIslands: number | null = null;
	let realSample: string | undefined;
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
			islands?: unknown[];
		} | null;
		if (result && typeof result.code === 'string') {
			real = true;
			realCode = result.code;
			realIslands = result.islands?.length ?? 0;
			realSample = result.islands?.[0] ? JSON.stringify(result.islands[0]).slice(0, 300) : undefined;
		}
	} catch (e) {
		realError = e instanceof Error ? `${e.message}` : String(e);
	}

	return {
		ok: marks.ok,
		error: marks.error,
		islands: marks.islands,
		output: real ? realCode : marks.output,
		real,
		realIslands,
		realSample,
		realError,
		oxc
	};
}

self.onmessage = (e: MessageEvent<{ id: number; source: string }>) => {
	const { id, source } = e.data;
	analyze(source).then((result) => self.postMessage({ id, result }));
};
