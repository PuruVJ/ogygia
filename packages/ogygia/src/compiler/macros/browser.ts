/**
 * The BROWSER-safe subset of the module-macro pipeline ({@link ./pipeline.ts}), for a REPL that runs the
 * real compiler in-browser (the Observatory) — the same passes, over the same parser, as a real build.
 *
 * It runs `import.meta.og.wire`, `.$` / `.store`, and the plugins' macros it is handed (content's `.code`
 * / `.md`, with the same Shiki/mdsvex renderers as a build). It deliberately OMITS only
 * `bake` — which runs `fn` at build via a mini rolldown bundle + `node:url` module eval (Node-only) —
 * so `run_module_macros` (which statically imports the node-only `bake` pass) stays out of the browser
 * bundle; this is the narrow, node-free slice the REPL needs. Keep the pass order in sync with pipeline.ts.
 *
 * The `$` / `store` passes emit a SELF-CONTAINED call (`__og_$(tag, bound, () => factory)` — the factory
 * is inline), so a single-tree live preview runs them by providing the runtime `__og_$` / `__og_store`
 * (see the Observatory's `ogygia/internal` module). The build's fn/store MANIFEST (the cross-island decode
 * fallback the driver emits from the hoists) is not needed here — the preview is one tree.
 */
import { rewrite_wire } from './wire.js';
import { rewrite_dollar } from './dollar.js';
import { rewrite_store } from './store.js';
import type { PluginMacro } from './pipeline.js';

const MARKUP_EXTS = ['.svelte'] as const;

/**
 * Run the browser-safe macro passes over one module. `source` is the current text; `macros` are the
 * plugins' browser-safe macros (content's `code` / `md`, built with the app's markdown config).
 * Returns the rewritten code and whether anything changed — the caller invalidates its own sourcemap
 * on `touched`.
 */
export async function run_browser_macros(
	source: string,
	id: string,
	macros: readonly PluginMacro[] = []
): Promise<{ code: string; touched: boolean }> {
	let out = source;
	let touched = false;

	// `import.meta.og.wire` → `static [Symbol.for('ogygia.wire')] = { codec }` (a live class's transport
	// codec). Pure AST rewrite — needs only the parser (already installed in the browser realm).
	if (out.includes('import.meta.og.wire')) {
		const rewritten = rewrite_wire(out, id, MARKUP_EXTS);
		if (rewritten !== out) {
			out = rewritten;
			touched = true;
		}
	}

	// `import.meta.og.$(fn)` → `__og_$(tag, bound, () => fn)` (a boundary-crossing fn ref). The factory
	// rides inline in the call, so the emitted code runs on its own — the driver's fn-MANIFEST (built from
	// the returned `hoists`, for a deferred island's decode fallback) isn't needed in a single-tree preview.
	if (out.includes('import.meta.og.$')) {
		const res = rewrite_dollar(out, id, id, MARKUP_EXTS);
		if (res.code !== out) {
			out = res.code;
			touched = true;
		}
	}

	// `import.meta.og.store(factory)` → `__og_store(tag, factory)` (registered at module load, products
	// branded). Same story: self-contained, so providing the runtime `__og_store` is all the preview needs.
	if (out.includes('import.meta.og.store')) {
		const rewritten = rewrite_store(out, id, id, MARKUP_EXTS);
		if (rewritten !== out) {
			out = rewritten;
			touched = true;
		}
	}

	// The plugins' macros (content's `code` / `md`: an inline pure-HTML region baked through the app's
	// own Shiki fence + mdsvex pipeline). Same order as the build's pipeline.
	for (const macro of macros) {
		if (!out.includes('import.meta.og.' + macro.name)) continue;
		const rewritten = await macro.handler(out, { id, rel: id, root: '/', markupExts: MARKUP_EXTS });
		if (rewritten !== out) {
			out = rewritten;
			touched = true;
		}
	}

	return { code: out, touched };
}
