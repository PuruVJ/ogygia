/**
 * Build-time render of a ONE-OFF code snippet to a serialized region — the engine behind
 * `import.meta.og.code(source, lang, meta?)`. It reuses the EXACT fence path a markdown code block
 * takes: the app's Shiki config (themes, transformers), the meta pipeline (so the `meta` infostring
 * behaves identically — `twoslash`, `{2-4}`, `file=…`, `// [!code …]`), variant generators, and the
 * content-addressed fence cache. So a snippet in a `.svelte` and the same snippet in a `.svx` fence
 * render byte-for-byte the same, and each renders once across a whole build.
 */
import { configure_shiki, fence_config_key, render_code_region } from './shiki.js';
import { default_pipeline, type CodePipeline } from './code-render.js';
import type { MarkdownOptions } from './index.js';
import type { SerializedRegion } from '../region-store.js';

/** Resolve the fence environment (`cfg`, `pipe`, `config_key`) from the app's markdown options —
 *  the same assembly `ogygiaPreprocess()` does, so snippets and fences share one configuration. */
function code_env(options: MarkdownOptions | null | undefined) {
	const { code, ...shiki_opts } = options ?? {};
	const cfg = configure_shiki({
		...shiki_opts,
		...(code?.transformers ? { transformers: code.transformers } : {})
	});
	const pipe: CodePipeline = {
		meta: code?.meta ?? default_pipeline().meta,
		variants: code?.variants ?? []
	};
	return { cfg, pipe, config_key: fence_config_key(cfg, pipe, code?.cacheSalt ?? '') };
}

/**
 * Render `source` (a `lang` snippet, with optional raw `meta` infostring) to a {@link SerializedRegion}
 * using the app's markdown config. Async (Shiki + variant generators load heavy deps). Cached.
 */
export async function render_snippet(
	options: MarkdownOptions | null | undefined,
	source: string,
	lang: string,
	meta?: string
): Promise<SerializedRegion> {
	const { cfg, pipe, config_key } = code_env(options);
	return render_code_region(cfg, pipe, config_key, source, lang, meta ?? '');
}
