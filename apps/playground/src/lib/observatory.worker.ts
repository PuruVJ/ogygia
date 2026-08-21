/**
 * OBSERVATORY WORKER — the heavy lifting runs OFF the main thread (the note's architecture: a worker
 * does the compiling, the UI just renders). It imports `svelte/compiler` (large) + MagicString, parses
 * the component the editor sends, finds the REAL marked-island imports, resolves each to a strategy,
 * and returns the island map + the rewritten host. The main-thread island never blocks on a parse, and
 * this is the same seam the later rungs grow into (the worker becomes the in-browser SERVER realm).
 */
// MUST be first: shims `process` for rolldown-browser (evaluated before the import below).
import './rd-process-shim.ts';
import { parse } from 'svelte/compiler';
// The SAME oxc parser the real ogygia transform uses (rolldown/utils in Node), here from rolldown's
// BROWSER build — same version, byte-identical AST. We use the ASYNC `parse` (it awaits the WASM
// instantiation); the sync `parseSync` only works after the WASM is pre-initialized, which the full
// browser compiler will do once at worker boot.
import { parse as oxc_parse_async } from '@rolldown/browser/utils';

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
	output: string;
	/** Proof the SAME oxc parser (rolldown-browser WASM) the full transform uses runs in-browser. */
	oxc?: { engine: string; ok: boolean; imports: number; error?: string };
}

/** Illustrative region id (the real build uses md5; this browser FNV-1a is for the preview). */
function region_id(s: string): string {
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

async function analyze(source: string): Promise<Analysis> {
	let ast: ReturnType<typeof parse>;
	try {
		ast = parse(source, { modern: true });
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e), islands: [], output: source };
	}
	const bodies: Array<Record<string, unknown>> = [];
	const inst = (ast as { instance?: { content?: { body?: unknown[] } } }).instance;
	const mod = (ast as { module?: { content?: { body?: unknown[] } } }).module;
	if (inst?.content?.body) bodies.push(...(inst.content.body as Array<Record<string, unknown>>));
	if (mod?.content?.body) bodies.push(...(mod.content.body as Array<Record<string, unknown>>));

	const islands: Island[] = [];
	// Host-rewrite edits, applied by plain splice (byte offsets are exact from the parser) — no
	// MagicString dep, which the worker's separate bundle couldn't resolve from the app.
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
		const id = region_id(component + ' ' + JSON.stringify(attrs));
		islands.push({ local, component, attrs, strategy, id });

		edits.push({
			start: node.start as number,
			end: node.end as number,
			text: `import ${local} from 'virtual:ogygia/wrapper/${id}'; // ${strategy.kind}`
		});
	}
	// Apply descending so earlier offsets stay valid as we splice.
	let output = source;
	for (const e of edits.sort((a, b) => b.start - a.start)) {
		output = output.slice(0, e.start) + e.text + output.slice(e.end);
	}

	// PROOF: run the SAME oxc parser the real transform uses (here from rolldown's browser/WASM build)
	// on the instance script. This is the parser the full browser compiler will run throughout; if the
	// WASM loads and parses TS in this worker, the whole approach is unblocked.
	let oxc: Analysis['oxc'];
	try {
		const content = (ast as { instance?: { content?: { start?: number; end?: number } } }).instance
			?.content;
		const script =
			content && content.start != null && content.end != null
				? source.slice(content.start, content.end)
				: '';
		const res = (await oxc_parse_async('host.ts', script)) as {
			program?: { body?: Array<{ type: string }> };
			errors?: unknown[];
		};
		const body = res.program?.body ?? [];
		oxc = {
			engine: 'rolldown-browser (oxc/wasm)',
			ok: !(res.errors && res.errors.length),
			imports: body.filter((n) => n.type === 'ImportDeclaration').length
		};
	} catch (err) {
		oxc = {
			engine: 'rolldown-browser (oxc/wasm)',
			ok: false,
			imports: 0,
			error: err instanceof Error ? err.message : String(err)
		};
	}

	return { ok: true, islands, output, oxc };
}

self.onmessage = (e: MessageEvent<{ id: number; source: string }>) => {
	const { id, source } = e.data;
	analyze(source).then((result) => self.postMessage({ id, result }));
};
