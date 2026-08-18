/**
 * The fence pipeline RUNNER — turns one authored fence into rendered HTML by threading it through the
 * stages (meta → variants → highlight → chrome). Emits STATIC HTML: all variants inline, visibility
 * switched by a {@link preference} CSS attribute (svelte.dev's proven `:has()`/attr model), plus inert
 * switcher markup the shell wires with one delegated handler. Zero islands, csr=false-native.
 *
 * The single-variant path returns just the highlighted `<pre>` (the caller stamps `data-lang`/id and
 * wraps it) so a plain ` ```ts ` fence is byte-identical to before — the pipeline is inert until a
 * `variants` generator claims a fence.
 */
import { infostring, run_meta, run_variants, type Fence, type MetaParser, type VariantGenerator } from './code.js';

/** The configured fence pipeline (from `markdown({ code })`). */
export type CodePipeline = {
	meta: MetaParser[];
	variants: VariantGenerator[];
};

/** Default pipeline: the infostring meta parser, no variant generators. */
export function default_pipeline(): CodePipeline {
	return { meta: [infostring()], variants: [] };
}

export type FenceRender = {
	/** The rendered HTML (a single `<pre>`, or a multi-variant `<div class="og-code">…`). */
	html: string;
	/** How many variants were produced (1 = the plain path). */
	count: number;
	/** The (possibly meta-stripped) primary source and its filename, for chrome/copy. */
	source: string;
	file?: string;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Run the pipeline for one fence. `highlight(source, lang, rawMeta)` produces the Shiki HTML for a
 * variant (rawMeta flows through as `__raw` for meta transformers).
 */
export async function render_fence(
	code: string,
	lang: string,
	raw_meta: string,
	pipeline: CodePipeline,
	highlight: (source: string, lang: string, rawMeta: string) => Promise<string>
): Promise<FenceRender> {
	let fence: Fence = { lang, raw_meta, meta: {}, source: code };
	fence = run_meta(pipeline.meta, fence);

	let claimed: ReturnType<typeof run_variants> = null;
	if (pipeline.variants.length) {
		// Let generators load heavy deps (e.g. the TS compiler) before they can produce their variants.
		await Promise.all(pipeline.variants.map((g) => g.ready?.()));
		claimed = run_variants(pipeline.variants, fence);
	}

	const file = typeof fence.meta.file === 'string' ? fence.meta.file : undefined;

	// Single variant — return the bare highlighted <pre>; the caller stamps + wraps (unchanged path).
	if (!claimed || claimed.variants.length < 2) {
		const html = await highlight(fence.source, fence.lang, fence.raw_meta);
		return { html, count: 1, source: fence.source, ...(file ? { file } : {}) };
	}

	// Multi-variant — highlight each, inline them all, switch by the preference attr.
	const pref = claimed.by.pref;
	const rendered = await Promise.all(
		claimed.variants.map(async (v) => ({ v, html: await highlight(v.fence.source, v.fence.lang, v.fence.raw_meta) }))
	);
	const panels = rendered
		.map(({ v, html }) => `<div class="og-variant" data-pref-value="${esc(v.value)}">${html}</div>`)
		.join('');
	// Inert switcher: one control per value, tagged with the preference name + value. The shell's
	// delegated handler reads `data-pref`/`data-pref-set` and calls `preference(name).set(value)`.
	const controls = claimed.variants
		.map((v) => `<button type="button" class="og-variant-btn" data-pref="${esc(pref.name)}" data-pref-set="${esc(v.value)}"${v.value === pref.default ? ' data-default' : ''}>${esc(v.label)}</button>`)
		.join('');
	const html =
		`<div class="og-code" data-pref="${esc(pref.name)}"${file ? ` data-file="${esc(file)}"` : ''}>` +
		`<div class="og-code-controls" role="tablist">${controls}</div>` +
		panels +
		`</div>`;
	return { html, count: rendered.length, source: fence.source, ...(file ? { file } : {}) };
}
