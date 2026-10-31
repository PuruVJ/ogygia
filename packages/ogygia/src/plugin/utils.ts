/**
 * `ogygia/plugin/utils` — small pure helpers several plugins need. No context, no state: safe to
 * import anywhere (a browser bundle included).
 */

/** Sticky 32-bit FNV-1a — uniform and deterministic, not cryptographic. */
export { fnv1a32 } from '../runtime/hash.js';
/** An attribute value with `&` and `"` escaped (unchanged, uncopied, when it has neither). */
export { escape_amp_quot as escapeAttr } from '../escape.js';
/** A byte- and count-bounded LRU map (a process-local cache that can never grow without bound). */
export { SizedLru } from '../server/sized-lru.js';
/** The receipt tag one `(source, args)` call files, or null for a function not declared with
 *  `import.meta.og.source`. */
export { source_tag_of as sourceTag } from '../source.js';
/** The Standard Schema interface (standardschema.dev): validate a value with any schema library. */
export type { StandardSchemaV1 } from '../router/view.js';
