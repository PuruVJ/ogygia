/**
 * `ogygia/plugin/utils` — small pure helpers several plugins need. No context, no state: safe to
 * import anywhere (a browser bundle included).
 */

/** Sticky 32-bit FNV-1a — uniform and deterministic, not cryptographic. */
export { fnv1a32 } from '../runtime/hash.ts';
/** An attribute value with `&` and `"` escaped (unchanged, uncopied, when it has neither). */
export { escape_amp_quot as escapeAttr } from '../escape.ts';
/** Text content with `&`, `<` and `>` escaped (unchanged, uncopied, when it has none). */
export { escape_text as escapeText } from '../escape.ts';
/** A byte- and count-bounded LRU map (a process-local cache that can never grow without bound). */
export { SizedLru } from '../server/sized-lru.ts';
/** The receipt tag one `(source, args)` call files, or null for a function not declared with
 *  `import.meta.og.source`. */
export { source_tag_of as sourceTag } from '../source.ts';
/** The Standard Schema interface (standardschema.dev): validate a value with any schema library. */
export type { StandardSchemaV1, StandardResult, StandardIssue } from './standard-schema.ts';

const BACKSLASHES = /\\/g;
const LEADING_SLASH = /^\//;
/**
 * The stable cross-build key for a markup module's own scoped CSS (a `.svx` body with a `<style>`):
 * the path from the first `/src/` segment, POSIX (`/…/proj/src/content/docs/x.svx` →
 * `content/docs/x.svx`). The preprocessor that bakes the key into the module and the build that emits
 * the CSS and writes the handoff compute it identically from the same absolute filename.
 */
export function content_css_key(abs: string): string {
	const p = abs.replace(BACKSLASHES, '/').split('?')[0];
	const i = p.indexOf('/src/');
	return i >= 0 ? p.slice(i + 5) : p.replace(LEADING_SLASH, '');
}
export { content_css_key as contentCssKey };
