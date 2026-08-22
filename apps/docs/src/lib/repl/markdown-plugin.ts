/**
 * Runs ogygia's REAL content/markdown pipeline (mdsvex + Shiki fences + admonitions + heading ids/anchors
 * + frontmatter + link collection) inside the Observatory bundler, so a `.md` / `.svx` entry previews as
 * a live content page — the same transform the shipped Vite plugin uses, not a bespoke REPL markdown.
 *
 * `ogygiaPreprocess().markup()` turns markdown → Svelte source; we then svelte-compile it (like
 * {@link ./svelte-plugin.ts}) so rolldown links + mounts it. The browser host ({@link ./browser-host.ts})
 * must be installed first (region ids / fence keys hash through the compiler seam).
 */
import { compile } from 'svelte/compiler';
import { ogygiaPreprocess } from 'ogygia/content/markdown';

export const MD_MODULE = /\.(md|svx)(\?|$)/;
// The pipeline injects a `() => import('./self.md?raw')` source-export; that dynamic `?raw` specifier
// can't resolve in the REPL bundle, so strip the whole line (the REPL doesn't use `emit.raw`).
const OG_SOURCE_LINE = /^[ \t]*export const __ogygia_source\b.*$/m;
// Strip ogygia `with { … }` import dials → plain component imports for the whole-app live mount (islands
// authored inside content render as plain components in the live leg, same as a `.svelte` live preview).
const WITH_DIAL = /(\bfrom\s*['"][^'"]+['"])\s*with\s*\{[^}]*\}/g;

// ONE shared content preprocessor (the plugin's bundle leg + the worker's analyze/SSR leg use the same
// instance — one shiki highlighter, one config). The browser host must be installed before first use.
let shared: ReturnType<typeof ogygiaPreprocess> | null = null;
export function content_preprocessor(): ReturnType<typeof ogygiaPreprocess> {
	return (shared ??= ogygiaPreprocess());
}

/** Run ogygia's markdown pipeline → SVELTE SOURCE (mdsvex + shiki + admonitions + heading ids), with the
 *  REPL-incompatible `?raw` source-export stripped and island dials flattened for the plain live mount.
 *  The intermediate the SSR/analyze legs compile to server JS and the bundle leg compiles to client JS. */
export async function md_to_svelte(content: string, filename: string): Promise<string> {
	const out = (await content_preprocessor().markup?.({ content, filename })) as { code?: string } | undefined;
	return (out?.code ?? content).replace(OG_SOURCE_LINE, '').replace(WITH_DIAL, '$1');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RolldownPlugin = any;

export interface MarkdownPluginOptions {
	/** `'client'` (mount) or `'server'` (SSR). Defaults to client. */
	generate?: 'client' | 'server';
}

export function markdownPlugin(opts: MarkdownPluginOptions = {}): RolldownPlugin {
	const generate = opts.generate ?? 'client';
	return {
		name: 'ogygia-markdown',
		async transform(code: string, id: string) {
			if (!MD_MODULE.test(id)) return null;
			const filename = id.split('?')[0];
			const src = await md_to_svelte(code, filename);
			const { js } = compile(src, {
				filename: filename.split('/').pop() || filename,
				generate,
				dev: false
			}) as { js: { code: string; map: unknown } };
			return { code: js.code, map: js.map ?? null };
		}
	};
}
