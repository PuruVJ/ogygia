/**
 * Build-time render of a Markdown STRING to static HTML — the engine behind `import.meta.og.md(text)`.
 * It runs the text through the app's OWN markdown preprocessor (the same remark/rehype plugins, the
 * same Shiki fence pipeline), then re-emits it as a serialized region's html via {@link try_region_emit}
 * — so a `md()` string and a `.md`/`.svx` document render identically. Region mode is forced OFF here
 * so the preprocessor hands back the compiled module and we run the emit ourselves for the clean
 * `{ html }`; the memoized preprocessor group keeps mdsvex init off the per-call path.
 *
 * `md()` is for STATIC prose (with fenced code). Content that compiles to something dynamic — an
 * island import, a `<script>`, a component tag, a Svelte expression — is a build error: that's what a
 * real component is for. Same contract the `.md` region path already enforces.
 */
import type { PreprocessorGroup } from 'svelte/compiler';
import { ogygiaPreprocess, type MarkdownOptions } from './index.js';
import { try_region_emit } from './region-emit.js';

// One preprocessor group per markdown-config object (mdsvex init is heavy; the config is stable).
const groups = new WeakMap<object, PreprocessorGroup>();
let null_group: PreprocessorGroup | null = null;

function group_for(options: MarkdownOptions | null | undefined): PreprocessorGroup {
	// `region: false` — we want the compiled module back, then run the emit ourselves for `{ html }`.
	const build = () => ogygiaPreprocess({ ...(options ?? {}), region: false }) as PreprocessorGroup;
	if (!options) return (null_group ??= build());
	let g = groups.get(options as object);
	if (!g) groups.set(options as object, (g = build()));
	return g;
}

/** Render `text` (Markdown) to static HTML using the app's markdown config. Async (mdsvex + Shiki).
 *  Throws build-voice when the content isn't pure-static. */
export async function render_markdown(
	options: MarkdownOptions | null | undefined,
	text: string
): Promise<string> {
	const group = group_for(options);
	const out = (await group.markup?.({ content: text, filename: 'og-md-snippet.md' })) as
		| { code?: string }
		| undefined;
	const emitted = try_region_emit(out?.code ?? text, []);
	if (!emitted) {
		throw new Error(
			`[ogygia/content] import.meta.og.md(): the content compiled to something dynamic (a script, component tag, island import, or Svelte expression). md() is for static prose + fenced code — use a component for anything live.`
		);
	}
	return emitted.html;
}
