/**
 * Strip twoslash compiler directives from displayed fences — a `MetaParser` value for the ogygia
 * fence pipeline (`code.meta`).
 *
 * The svelte.dev corpus annotates fences for twoslash: `// @errors: 7034 7005`, `// @filename:
 * ambient.d.ts`, `// @noErrors`, `// @lib: …`, and `// ---cut---` (everything above the cut is
 * type-checking preamble, not display material). svelte.dev's build CONSUMES these; we don't run
 * twoslash, so without this pass they print as literal comments (exactly the bug on the
 * state-management page). Runs before variants, so the JS→TS converter and the highlighter both see
 * clean source, and the copy button copies what's on screen.
 */
import type { Fence, MetaParser } from 'ogygia/content/markdown';

/** The twoslash directives present in the corpus (checked: @filename ×140, @errors ×69,
 *  @noErrors ×41, @lib ×2). A conservative allowlist — real code comments like
 *  `// @ts-expect-error` must stay visible. */
const DIRECTIVE = /^\s*\/\/ @(?:errors|filename|noErrors|noErrorValidation|lib|module|moduleResolution|target|strict)\b.*$/;

const CUT = /^\s*\/\/ ---cut---\s*$/;

export function twoslash_strip(): MetaParser {
	return (fence: Fence): Fence => {
		if (fence.lang !== 'js' && fence.lang !== 'ts' && fence.lang !== 'svelte') return fence;
		if (!fence.source.includes('// @') && !fence.source.includes('---cut---')) return fence;

		let lines = fence.source.split('\n');

		// `// ---cut---`: display only what's below the LAST cut (preamble above exists for the
		// type-checker we don't run).
		const cut = lines.findLastIndex((l) => CUT.test(l));
		if (cut !== -1) lines = lines.slice(cut + 1);

		lines = lines.filter((l) => !DIRECTIVE.test(l));

		// Collapse the blank run a stripped directive block leaves at the top.
		while (lines.length && lines[0]!.trim() === '') lines.shift();

		const source = lines.join('\n');
		return source === fence.source ? fence : { ...fence, source };
	};
}
