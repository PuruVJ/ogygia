/**
 * The BROWSER-safe subset of the module-macro pipeline ({@link ./pipeline.ts}), for a REPL that runs the
 * real compiler in-browser (the Observatory). It runs `import.meta.og.wire` and `import.meta.og.code` /
 * `.md` — the same passes, over the same parser, with the same Shiki/mdsvex renderers as a real build.
 *
 * It deliberately OMITS:
 *   - `bake` — runs `fn` at build via a mini rolldown bundle + `node:url` module eval (Node-only);
 *   - `$` / `store` — their transport hoists need the fn/store manifest emit the driver owns.
 * So `run_module_macros` (which statically imports the node-only `bake` pass) stays out of the browser
 * bundle; this is the narrow, node-free slice the REPL needs. Keep the pass order in sync with pipeline.ts.
 */
import { rewrite_wire } from './wire.js';
import { rewrite_code } from './code.js';
import { render_snippet } from '../../content/markdown/snippet.js';
import { render_markdown } from '../../content/markdown/render-md.js';
import type { MarkdownOptions } from '../../content/markdown/index.js';

const MARKUP_EXTS = ['.svelte'] as const;

/**
 * Run the browser-safe macro passes over one module. `source` is the current text; `markdownConfig` is
 * the app's markdown config (drives `.code`/`.md` themes + transformers), or `null`. Returns the
 * rewritten code and whether anything changed — the caller invalidates its own sourcemap on `touched`.
 */
export async function run_browser_macros(
	source: string,
	id: string,
	markdownConfig: MarkdownOptions | null
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

	// `import.meta.og.code(src, lang, meta?)` / `.md(text)` → an inline pure-HTML region baked through
	// the app's own Shiki fence + mdsvex pipeline, inlined as `og_html_region("…")`. Async (Shiki).
	if (out.includes('import.meta.og.code') || out.includes('import.meta.og.md')) {
		const rewritten = await rewrite_code(out, id, MARKUP_EXTS, async (call) =>
			call.kind === 'md'
				? render_markdown(markdownConfig, call.source)
				: (await render_snippet(markdownConfig, call.source, call.lang, call.meta)).html
		);
		if (rewritten !== out) {
			out = rewritten;
			touched = true;
		}
	}

	return { code: out, touched };
}
