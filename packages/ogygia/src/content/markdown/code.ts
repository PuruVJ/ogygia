/**
 * The fence pipeline — the CODE dialect's contracts. A fence flows through fixed stages, each a
 * composition of imported VALUES (core knows the contracts, never the features):
 *
 *   meta (LAYER) → variants (RACE) → highlight (shiki transformers) → chrome
 *
 *  - a {@link MetaParser} enriches `fence.meta` and may rewrite `fence.source` (strip magic comments);
 *    parsers layer, later wins on collision. Default: `[infostring()]`.
 *  - a {@link VariantGenerator} turns one authored fence into N labeled versions bound to a
 *    {@link Preference}; generators race, the first non-null claims the fence (a JS↔TS converter,
 *    package-manager tabs — app-authored values against this contract).
 *
 * These are pure functions over {@link Fence} — unit-testable with no Vite. The wiring into the
 * markdown highlighter + the sticky-choice CSS lives in the pipeline runner (see `code-render.ts`).
 */
import type { PreferenceSpec } from '../../preference.js';

/** One code fence, as the pipeline sees it. `raw_meta` is the untouched infostring after the lang. */
export type Fence = {
	lang: string;
	raw_meta: string;
	meta: Record<string, unknown>;
	source: string;
};

/** Enriches `meta` / rewrites `source`. Parsers LAYER (run in order; later wins on a meta collision). */
export type MetaParser = (fence: Fence) => Fence;

/** One rendered version of a fence: a switcher label, a stable value, and its (re-langed) fence. */
export type Variant = { label: string; value: string; fence: Fence };

/**
 * Turns one authored fence into N labeled variants + the {@link Preference} its switcher binds to, or
 * `null` when the fence isn't this generator's (the race continues). `throw` = "mine and broken" (a
 * named build error). `cache_key` folds an external identity (e.g. the TS version) into the fence cache.
 */
export type VariantGenerator = {
	pref: PreferenceSpec;
	generate: (fence: Fence) => Variant[] | null;
	/** Folds an external identity (e.g. the TS compiler version) into the fence cache key. */
	cache_key?: string;
	/** Optional: heavy deps to load before `generate` is meaningful (the runner awaits it once). */
	ready?: () => Promise<void>;
};

// ── runners (pure) ──

/** Layer every meta parser over a fence, in order. */
export function run_meta(parsers: MetaParser[], fence: Fence): Fence {
	return parsers.reduce((f, p) => p(f), fence);
}

/** Race the variant generators: the FIRST to return a non-null set claims the fence. Returns the
 *  claiming generator (for its `pref`/`cache_key`) + its variants, or null if none claimed. */
export function run_variants(
	generators: VariantGenerator[],
	fence: Fence
): { by: VariantGenerator; variants: Variant[] } | null {
	for (const g of generators) {
		const variants = g.generate(fence);
		if (variants && variants.length) return { by: g, variants };
	}
	return null;
}

// ── built-in meta parsers (VALUES) ──

const QUOTED = /(\w[\w-]*)\s*=\s*"([^"]*)"/g;
const BARE = /(\w[\w-]*)\s*=\s*([^\s"'{}]+)/g;

/**
 * The default fence-meta parser: reads CHROME meta from the infostring after the language —
 * `key="value"` and `key=value` pairs (`title="app.js"` / `file="app.js"`, `copy=false`,
 * `link=false`). Booleans coerce; `title` mirrors to `file` (the filename-label key).
 *
 * It DELIBERATELY does not touch line-highlight syntax (`{1-3,5}`, `/word/`, `// [!code …]`) — that
 * is a Shiki transformer's job (`@shikijs/transformers`, `transformerMetaHighlight`), fed by the raw
 * infostring which the pipeline passes straight to `codeToHtml`. Zero config: ` ```js title="x" ` just works.
 */
export function infostring(): MetaParser {
	return (fence) => {
		const raw = fence.raw_meta;
		if (!raw) return fence;
		const meta = { ...fence.meta };
		const coerce = (v: string): unknown => (v === 'true' ? true : v === 'false' ? false : v);
		let m: RegExpExecArray | null;
		QUOTED.lastIndex = 0;
		while ((m = QUOTED.exec(raw))) meta[m[1]!] = m[2]!;
		BARE.lastIndex = 0;
		while ((m = BARE.exec(raw))) if (!(m[1]! in meta)) meta[m[1]!] = coerce(m[2]!);
		if (meta.title && !meta.file) meta.file = meta.title; // `title=` is the common filename spelling
		return { ...fence, meta };
	};
}

const SLASH_META =
	/(?:^|\n)[ \t]*(?:\/\/\/|<!---|###)\s*(file|copy|link|title)\s*:\s*(.*?)\s*(?:--->)?(?=\n|$)/g;
const LEADING_LFS_RE = /^\n+/;

/**
 * svelte.dev's magic-comment fence meta: `/// file: App.svelte`, `/// copy: false`, `/// link: false`
 * (also `<!--- file: … --->` for Svelte, `### file: …`). Reads the keys into `meta` and STRIPS the
 * comment lines from `source` so they never render. `file` also sets `meta.file` (filename label).
 */
export function slash_meta(): MetaParser {
	return (fence) => {
		let src = fence.source;
		const meta = { ...fence.meta };
		let m: RegExpExecArray | null;
		SLASH_META.lastIndex = 0;
		let found = false;
		while ((m = SLASH_META.exec(fence.source))) {
			found = true;
			const key = m[1]!;
			const val = m[2]!;
			meta[key] = val === 'true' ? true : val === 'false' ? false : val;
		}
		if (found) src = fence.source.replace(SLASH_META, '').replace(LEADING_LFS_RE, '');
		return found ? { ...fence, meta, source: src } : fence;
	};
}
