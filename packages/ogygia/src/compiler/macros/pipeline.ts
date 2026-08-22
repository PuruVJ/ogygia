/**
 * The module-macro pipeline — the ordered `import.meta.og.*` passes that run BEFORE either branch
 * (island transform / svelte compile / ts-region minting) sees a module: `wire`, `$`, `store`,
 * auto-branding, `code`/`md`, and `bake`. Each pass is a no-op unless its exact marker is present, is
 * extension-aware, and (where it matters) AST-precise. Pulled out of the Vite adapter so the whole
 * macro leg is one call (`Compiler.macros`) the driver owns — a REPL runs the same passes with no Vite
 * in sight. Pure over `(source, id, ctx)` apart from the `dollarHoists` map it fills and the profiler
 * timing it records; returns `{ code, touched }` (the caller invalidates its own sourcemap on touch).
 */
import { path } from '../host.js';
import { performance } from 'node:perf_hooks';
import { rewrite_wire } from './wire.js';
import { rewrite_dollar } from './dollar.js';
import { rewrite_store, auto_brand_stores } from './store.js';
import { rewrite_code } from './code.js';
import { rewrite_bake, type AliasEntry } from './bake.js';
import { render_snippet } from '../../content/markdown/snippet.js';
import { render_markdown } from '../../content/markdown/render-md.js';
import type { MarkdownOptions } from '../../content/markdown/index.js';
import type { Profiler } from '../driver.js';

const CONSTRUCT_MARKUP_EXTS = ['.svelte'] as const;

export interface MacroPipelineCtx {
	root: string;
	/** Resolved Vite aliases the `bake` pass hands to its mini-bundler. */
	resolveAlias: unknown[];
	/** The app's markdown config, or `null` when content is off. */
	markdownConfig: MarkdownOptions | null;
	/** ogygia's own package root — auto-brand skips ogygia source. */
	pkgRoot: string;
	/** Filled with every `import.meta.og.$` hoist (tag → factory source) for the fn-manifest emit. */
	dollarHoists: Map<string, string>;
}

/**
 * Run the ordered macro passes over one module. `source` is the CURRENT text (a content-preset tag
 * or an earlier pass may already have edited it upstream) — never the raw file — because each pass
 * feeds the next. Returns the rewritten code and whether anything changed.
 */
export async function run_module_macros(
	source: string,
	id: string,
	ctx: MacroPipelineCtx,
	profiler: Profiler
): Promise<{ code: string; touched: boolean }> {
	let out = source;
	let touched = false;

	// `import.meta.og.wire` — the transportable-codec key, rewritten to `Symbol.for('ogygia.wire')`
	// BEFORE either branch (island transform / svelte compile / ts region minting) sees the code,
	// so the class body's computed key is a real symbol expression by compile time. Extension-aware
	// and AST-precise (see og-wire.ts); a no-op unless the marker is actually present.
	if (out.includes('import.meta.og.wire')) {
		const rewritten = rewrite_wire(out, id, CONSTRUCT_MARKUP_EXTS);
		if (rewritten !== out) {
			out = rewritten;
			touched = true;
		}
	}

	// `import.meta.og.$(fn)` — hoist a function so its VALUE crosses a boundary as a fn
	// ref (og-dollar.ts). Exact marker ('.$state' can never match) + AST verification.
	if (out.includes('import.meta.og.$')) {
		const rel_dollar = path.relative(ctx.root, id.split('?')[0]).split(path.sep).join('/');
		const res = rewrite_dollar(out, id, rel_dollar, CONSTRUCT_MARKUP_EXTS);
		if (res.code !== out) {
			out = res.code;
			touched = true;
			for (const h of res.hoists) ctx.dollarHoists.set(h.tag, h.factory_src);
		}
	}

	// `import.meta.og.store(factory)` — assert a store factory: registered under a build
	// tag at module load, products branded (og-store.ts).
	if (out.includes('import.meta.og.store')) {
		const rel_store = path.relative(ctx.root, id.split('?')[0]).split(path.sep).join('/');
		const rewritten = rewrite_store(out, id, rel_store, CONSTRUCT_MARKUP_EXTS);
		if (rewritten !== out) {
			out = rewritten;
			touched = true;
		}
	}

	// AUTO-BRAND provable store factories (export const x = (seed) => store-shape) so the
	// registered-factory tier needs zero authoring for the common shapes. App source only —
	// never node_modules (their factories can't self-register on the client anyway).
	if (!id.includes('node_modules') && !id.startsWith(ctx.pkgRoot) && /export\s+const/.test(out)) {
		const rel_auto = path.relative(ctx.root, id.split('?')[0]).split(path.sep).join('/');
		const branded = auto_brand_stores(out, id, rel_auto, CONSTRUCT_MARKUP_EXTS);
		if (branded !== out) {
			out = branded;
			touched = true;
		}
	}

	// `import.meta.og.code(source, lang, meta?)` — a highlighted snippet, baked to a static
	// region through the app's own Shiki fence pipeline (same themes/transformers/meta parsers)
	// and inlined as `og_html_region("…")`. Async (Shiki). Runs before the island transform so
	// the injected `og_html_region` import + region value flow through normally. The renderer is
	// dynamically imported so a build without any `code()` call never loads Shiki here.
	if (out.includes('import.meta.og.code') || out.includes('import.meta.og.md')) {
		const md_cfg = ctx.markdownConfig;
		const rewritten = await rewrite_code(out, id, CONSTRUCT_MARKUP_EXTS, async (call) => {
			if (call.kind === 'md') return render_markdown(md_cfg, call.source);
			const region = await render_snippet(md_cfg, call.source, call.lang, call.meta);
			return region.html;
		});
		if (rewritten !== out) {
			out = rewritten;
			touched = true;
		}
	}

	// `import.meta.og.bake(fn)` — run fn at build (rolldown-bundle the imports it uses +
	// execute), devalue-serialize the result, inline it as a literal, and drop imports that only
	// fed a baked fn. Extension-aware (whole file for .ts/.js, `<script>` blocks for .svelte).
	// Runs before the island transform so downstream sees plain data, not a call.
	if (out.includes('import.meta.og.bake')) {
		const __bk = profiler.P ? performance.now() : 0;
		const rewritten = await rewrite_bake(out, id, {
			alias: ctx.resolveAlias as AliasEntry[],
			root: ctx.root,
			markupExts: CONSTRUCT_MARKUP_EXTS
		});
		if (rewritten !== out) {
			out = rewritten;
			touched = true;
		}
		if (profiler.P) {
			profiler.prof.bakeMs += performance.now() - __bk;
			profiler.prof.bakeN++;
		}
	}

	return { code: out, touched };
}
