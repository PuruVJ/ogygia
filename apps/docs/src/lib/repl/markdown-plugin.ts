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
import { ogygiaPreprocess, diff_markers, inline_markers } from 'ogygia/content/markdown';
import type { ReplMarkdownConfig } from './repl-config.ts';

export const MD_MODULE = /\.(md|svx)(\?|$)/;
// The pipeline injects a `() => import('./self.md?raw')` source-export; that dynamic `?raw` specifier
// can't resolve in the REPL bundle, so strip the whole line (the REPL doesn't use `emit.raw`).
const OG_SOURCE_LINE = /^[ \t]*export const __ogygia_source\b.*$/m;
// Strip ogygia `with { … }` import dials → plain component imports for the whole-app live mount (islands
// authored inside content render as plain components in the live leg, same as a `.svelte` live preview).
const WITH_DIAL = /(\bfrom\s*['"][^'"]+['"])\s*with\s*\{[^}]*\}/g;

// ONE shared content preprocessor (the plugin's bundle leg + the worker's analyze/SSR leg use the same
// instance — one shiki highlighter, one config). The browser host must be installed before first use.
// Rebuilt only when the user's config (from a workspace vite.config.ts) actually changes — building it
// constructs a shiki highlighter, so it's signature-gated.
let shared: ReturnType<typeof ogygiaPreprocess> | null = null;
let shared_sig = '\0uninit';

/** The default fence dialects the docs site ships — line `+++ `/`--- ` + inline `+++x+++`/`---x---` —
 *  used when a config doesn't set its own transformers. */
const default_transformers = () => [diff_markers(), inline_markers()];

/** A stable signature of a config so we rebuild the preprocessor only on a real change (transformers are
 *  objects → sign by their `name`). */
function config_signature(md: ReplMarkdownConfig | null): string {
	if (!md) return 'default';
	const { code, ...rest } = md;
	const names = code?.transformers?.map((t) => (t && typeof t === 'object' ? (t.name ?? '?') : '?')).join(',') ?? '';
	return JSON.stringify(rest) + '|' + names;
}

/** Configure the content pipeline from a parsed workspace config (null → REPL defaults). Idempotent per
 *  signature. Call before {@link md_to_svelte} (the worker does, per analyze/bundle). */
export function configure_content(md: ReplMarkdownConfig | null): void {
	const sig = config_signature(md);
	if (sig === shared_sig && shared) return;
	shared_sig = sig;
	const cfg: ReplMarkdownConfig = md ? { ...md } : {};
	// Default the two diff transformers on when the config didn't set `code.transformers` at all.
	if (!cfg.code?.transformers?.length) cfg.code = { transformers: default_transformers() };
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	shared = ogygiaPreprocess(cfg as any);
}

export function content_preprocessor(): ReturnType<typeof ogygiaPreprocess> {
	if (!shared) configure_content(null);
	return shared!;
}

/** Markdown → SVELTE SOURCE (mdsvex + shiki + admonitions + …), with only the REPL-incompatible `?raw`
 *  source-export stripped. Island `with { … }` dials are PRESERVED — the caller decides. */
async function markup_to_svelte(content: string, filename: string): Promise<string> {
	const out = (await content_preprocessor().markup?.({ content, filename })) as { code?: string } | undefined;
	return (out?.code ?? content).replace(OG_SOURCE_LINE, '');
}

/** The compile view: island dials flattened to plain imports, so the SSR/client/bundle legs svelte-compile
 *  content as a normal component (they can't parse `with { … }` import attributes). */
export async function md_to_svelte(content: string, filename: string): Promise<string> {
	return (await markup_to_svelte(content, filename)).replace(WITH_DIAL, '$1');
}

/** The ISLANDS view: dials KEPT, so the real transform's mark scan (build_island_info) can find an island
 *  authored inside content and the islands-mode runtime actually wakes it. */
export async function md_to_svelte_islands(content: string, filename: string): Promise<string> {
	return markup_to_svelte(content, filename);
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
			// css:'injected' — a content page's own scoped `<style>` mounts with it (the REPL has no separate
			// CSS pipeline), matching the bundle's .svelte handling.
			const { js } = compile(src, {
				filename: filename.split('/').pop() || filename,
				generate,
				dev: false,
				css: 'injected'
			}) as { js: { code: string; map: unknown } };
			return { code: js.code, map: js.map ?? null };
		}
	};
}
