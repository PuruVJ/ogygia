/**
 * `import.meta.og.code(…)` and `.md(…)` as plugin macros: each call baked through the app's markdown
 * config (Shiki fences, remark/rehype plugins) and inlined as a static region. Browser-safe (the
 * compiler's host seam), so the `content()` plugin registers these in a build and the Observatory REPL
 * hands the same pair to `run_browser_macros`.
 */
import type { MarkdownOptions } from '../markdown/index.ts';
import { render_snippet } from '../markdown/snippet.ts';
import { render_markdown } from '../markdown/render-md.ts';
import { rewrite_code } from './code.ts';

/** A macro the way ogygia's build (`b.macro`) and `run_browser_macros` take it. */
export interface SnippetMacro {
	name: 'code' | 'md';
	handler: (code: string, m: { id: string; markupExts: readonly string[] }) => Promise<string>;
}

/**
 * @internal The `code` / `md` macro pair for a markdown config (`null` = the defaults). Both markers
 * share one rewrite, so whichever runs first bakes both.
 */
export function snippet_macros(config: () => MarkdownOptions | null | undefined): SnippetMacro[] {
	const handler: SnippetMacro['handler'] = (code, m) => {
		const cfg = config();
		return rewrite_code(code, m.id, m.markupExts, async (call) => {
			if (call.kind === 'md') return render_markdown(cfg, call.source);
			return (await render_snippet(cfg, call.source, call.lang, call.meta)).html;
		});
	};
	return [
		{ name: 'code', handler },
		{ name: 'md', handler }
	];
}
